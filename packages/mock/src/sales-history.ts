import { addDays, businessDate, dayDiff, monthNumber, monthOf, paiseToRupees, weekdayOf, type SaleLine } from '@linck/domain';
import { PRODUCTS } from './data.js';
import { DAILY } from './series.js';
import { makeRng, NOW } from './seed.js';

/**
 * SALES HISTORY (LIN-7).
 *
 * Eighteen months of daily sales, by customer, material and site, up to the
 * mock's today — the past the director's sales trends and the heads-up read.
 * In the real system this is a daily roll-up of invoiced and cash loads
 * (`v_sales_daily`); here it is generated once, from fixed seeds, so every
 * reload shows the same history.
 *
 * WHAT IS IN IT, so the screens have something true to find:
 *
 *   The week.    Sundays run at about a third: half a shift at the plant and
 *                most lorries stand. Walk-in buyers come on Sundays more.
 *   The year.    January to May is the building season — March is the
 *                year-end rush to spend budgets. The north-east monsoon, mid
 *                October to December, cuts volume: heavy-rain days stop road
 *                work almost entirely, and November is the low month.
 *                Pongal, Ayudha Pooja and Deepavali all but close the yard.
 *   Customers.   Casagrand grows (new phases on OMR); Sri Venkateswara is
 *                steady; Radiance shrinks as its project winds down, and from
 *                July buys less than half as much; TN Highways buys GSB, WMM
 *                and 40mm by the road season; Alliance Infra stopped ordering
 *                six weeks ago; Purva Developers is new since December; and
 *                the counter sells small cash loads to walk-ins every day.
 *   Materials.   M-Sand keeps taking over from river sand, so it rises fast;
 *                P-Sand rises a little; 40mm holds flat; crusher dust slips.
 *   Rates.       Delivered rupees per unit, about where the trips and orders
 *                sit (₹4,000 for dust to ₹7,000 for P-Sand), rising about 5% a
 *                year, with a few percent of give at the gate.
 *
 * THE LAST 30 DAYS AGREE WITH THE DASHBOARD. The executive dashboard draws its
 * sales line from `DAILY`, and two screens that disagree about the same day
 * lose the director's trust in both. So each of those 30 days is scaled to
 * the units and rupees `DAILY` has for it, keeping the day's mix of customers,
 * materials and sites; the whole history is first scaled to the same level,
 * so day 31 does not step. `PRODUCT_MIX` ("What sold") is read from here.
 *
 * Own generators, so adding these rows cannot move a single number seeded
 * elsewhere in the mock.
 */

export const SALES_HISTORY_FROM = '2025-02-01';
export const SALES_HISTORY_TO = businessDate(NOW);

/** Delivered rupees per unit at today's prices. */
const LIST_RATE: Record<string, number> = {
  MSAND: 6300,
  PSAND: 7200,
  AGG6: 5900,
  AGG10: 6100,
  AGG20: 6000,
  AGG40: 5500,
  GSB: 4800,
  WMM: 5200,
  DUST: 4000,
};

/** How each material's demand drifts, per year: the M-Sand switch, dust slipping. */
const DRIFT_PER_YEAR: Record<string, number> = {
  MSAND: 0.24,
  PSAND: 0.08,
  AGG6: 0,
  AGG10: -0.04,
  AGG20: 0.02,
  AGG40: 0.12,
  GSB: 0,
  WMM: 0,
  DUST: -0.25,
};

/** Season, January to December, anchored on the 15th and blended day by day. */
const BUILDING_SEASON = [1.08, 1.14, 1.22, 1.18, 1.1, 0.98, 0.94, 0.95, 0.95, 0.93, 0.86, 0.88];
const ROAD_SEASON = [1.25, 1.35, 1.45, 1.35, 1.15, 0.85, 0.8, 0.85, 0.9, 0.78, 0.55, 0.65];

/** Sunday … Saturday. */
const WEEKDAY = [0.3, 1.03, 1, 1, 1, 0.98, 0.92];
const WALK_IN_SUNDAY = 0.55;

/** Days the yard all but closes. */
const HOLIDAYS: Record<string, number> = {
  '2025-04-14': 0.5, // Tamil New Year
  '2025-05-01': 0.6,
  '2025-08-15': 0.5,
  '2025-08-27': 0.5, // Vinayagar Chathurthi
  '2025-10-01': 0.3, // Ayudha Pooja: the machines are washed and garlanded, not run
  '2025-10-02': 0.5,
  '2025-10-20': 0.2, // Deepavali
  '2025-10-21': 0.6,
  '2025-12-25': 0.7,
  '2026-01-01': 0.7,
  '2026-01-14': 0.4, // Bhogi
  '2026-01-15': 0.15, // Thai Pongal
  '2026-01-16': 0.3, // Mattu Pongal
  '2026-01-17': 0.6,
  '2026-01-26': 0.5,
  '2026-04-14': 0.5,
  '2026-05-01': 0.6,
};

interface Profile {
  id: string;
  /** Units on an ordinary weekday at a normal season, `t` days into the history. */
  level: (t: number, date: string) => number;
  mix: Record<string, number>;
  /** Share loaded at Karapakkam; the rest at Thiruvallur. */
  krpShare: number;
  /** Units per load. */
  load: [number, number];
  /** Their rate against the list: contracts pay less, cash pays more. */
  rateFactor: number;
  road?: boolean;
  walkIn?: boolean;
}

/** Days from the first day of the history to the last. */
const SPAN = dayDiff(SALES_HISTORY_FROM, SALES_HISTORY_TO);
const RADIANCE_CUTS_BACK = '2026-07-01';
const ALLIANCE_LAST = '2026-06-26';
const ALLIANCE_SLOWS = '2026-06-01';
const PURVA_FROM = '2025-12-01';

const PROFILES: Profile[] = [
  {
    id: 'cus-01', // Casagrand — growing
    level: (t) => 26 + 20 * (t / SPAN), // 26 units a day to 46
    mix: { MSAND: 0.42, PSAND: 0.18, AGG20: 0.25, AGG10: 0.07, AGG6: 0.08 },
    krpShare: 0.75,
    load: [5, 11],
    rateFactor: 0.97,
  },
  {
    id: 'cus-02', // Sri Venkateswara — steady
    level: () => 30,
    mix: { MSAND: 0.33, PSAND: 0.14, AGG20: 0.3, AGG40: 0.13, AGG6: 0.1 },
    krpShare: 0.8,
    load: [5, 10],
    rateFactor: 1,
  },
  {
    id: 'cus-03', // Radiance — shrinking, then cut back hard
    // 32 units a day sliding to 20 by the end of June, then 8.
    level: (t, date) => (date >= RADIANCE_CUTS_BACK ? 8 : 32 - 12 * (t / dayDiff(SALES_HISTORY_FROM, RADIANCE_CUTS_BACK))),
    mix: { MSAND: 0.4, PSAND: 0.25, AGG20: 0.2, AGG10: 0.1, DUST: 0.05 },
    krpShare: 0.15,
    load: [4, 9],
    rateFactor: 1,
  },
  {
    id: 'cus-04', // TN Highways — road season
    level: () => 40,
    mix: { GSB: 0.33, WMM: 0.33, AGG40: 0.22, AGG20: 0.12 },
    krpShare: 0.85,
    load: [8, 12],
    rateFactor: 0.95,
    road: true,
  },
  {
    id: 'cus-05', // Alliance Infra — stopped six weeks ago
    level: (_t, date) => (date > ALLIANCE_LAST ? 0 : date >= ALLIANCE_SLOWS ? 13 : 20),
    mix: { MSAND: 0.4, AGG20: 0.32, AGG40: 0.08, PSAND: 0.2 },
    krpShare: 0.9,
    load: [5, 10],
    rateFactor: 0.99,
  },
  {
    id: 'cus-06', // Counter cash sale — walk-ins
    level: (t) => 18 * (1 + 0.04 * (t / 365)),
    mix: { MSAND: 0.3, DUST: 0.22, AGG6: 0.15, AGG20: 0.18, PSAND: 0.15 },
    krpShare: 0.4,
    load: [1.5, 4],
    rateFactor: 1.04,
    walkIn: true,
  },
  {
    id: 'cus-07', // Purva — new since December
    level: (_t, date) => (date < PURVA_FROM ? 0 : Math.min(24, (24 * (dayDiff(PURVA_FROM, date) + 1)) / 90)),
    mix: { MSAND: 0.45, PSAND: 0.2, AGG20: 0.25, AGG6: 0.1 },
    krpShare: 0.7,
    load: [5, 10],
    rateFactor: 0.98,
  },
];

function seasonOn(curve: readonly number[], date: string): number {
  const position = monthNumber(monthOf(date)) - 1 + (Number(date.slice(8, 10)) - 15) / 30.4;
  const i = Math.floor(position);
  const a = curve[(i + 12) % 12]!;
  const b = curve[(i + 13) % 12]!;
  return a + (b - a) * (position - i);
}

/** North-east monsoon: chance of a heavy-rain day, mid October to December. */
function heavyRainChance(date: string): number {
  const md = date.slice(5);
  if (md >= '10-15' && md <= '10-31') return 0.15;
  if (md >= '11-01' && md <= '11-30') return 0.28;
  if (md >= '12-01' && md <= '12-20') return 0.18;
  if (md >= '12-21') return 0.08;
  return 0;
}

const dates = Array.from({ length: SPAN + 1 }, (_, i) => addDays(SALES_HISTORY_FROM, i));

/** One draw a day for the weather, shared by every customer: rain falls on all of them. */
const weather = makeRng(20251115);
const RAIN: number[] = dates.map((date) => {
  const heavy = heavyRainChance(date);
  if (heavy === 0) return 1;
  const roll = weather();
  return roll < heavy ? 0.45 : roll < heavy + 0.22 ? 0.82 : 1;
});

const rng = makeRng(20250201);

function uniform(min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Knuth's method; λ here is never more than a dozen loads. */
function poisson(lambda: number): number {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

/** A day's mood: a customer's orders swing by about an eighth either way. */
function dayNoise(): number {
  const u = Math.max(rng(), 1e-9);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  return Math.exp(0.12 * z - 0.0072);
}

/**
 * A customer's loads follow their job, not a coin: a builder pouring slabs
 * takes M-Sand and 20mm in a steady ratio. So each load goes to whichever
 * material (or site) is most behind its share so far — smooth weighted
 * round-robin — and the day's total is where the chance lives.
 */
function nextByShare(owed: Map<string, number>, weights: [string, number][]): string {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let best = weights[0]![0];
  let bestOwed = -Infinity;
  for (const [key, w] of weights) {
    const o = (owed.get(key) ?? 0) + w / total;
    owed.set(key, o);
    if (o > bestOwed) {
      bestOwed = o;
      best = key;
    }
  }
  owed.set(best, bestOwed - 1);
  return best;
}

interface Draft {
  date: string;
  customerId: string;
  productCode: string;
  siteId: string;
  units: number;
  /** Rupees, unrounded until the end. */
  rupees: number;
}

const drafts = new Map<string, Draft>();
const owedMaterial = new Map(PROFILES.map((p) => [p.id, new Map<string, number>()]));
const owedSite = new Map(PROFILES.map((p) => [p.id, new Map<string, number>()]));

dates.forEach((date, t) => {
  const years = t / 365;
  const price = 1 + 0.05 * (dayDiff('2026-07-01', date) / 365);
  const weekday = weekdayOf(date);
  const holiday = HOLIDAYS[date] ?? 1;
  const rain = RAIN[t]!;

  for (const profile of PROFILES) {
    const base = profile.level(t, date);
    if (base <= 0) continue;
    const season = seasonOn(profile.road ? ROAD_SEASON : BUILDING_SEASON, date);
    const week = weekday === 0 && profile.walkIn ? WALK_IN_SUNDAY : WEEKDAY[weekday]!;
    // A heavy-rain day stops a road gang almost completely; a builder pours less.
    const wet = profile.road && rain < 1 ? rain * rain : rain;
    const expected = base * season * week * holiday * wet * dayNoise();
    const meanLoad = (profile.load[0] + profile.load[1]) / 2;
    const loads = poisson(expected / meanLoad);
    if (loads === 0) continue;

    const mix: [string, number][] = Object.entries(profile.mix).map(([code, w]) => [
      code,
      Math.max(0.01, w * (1 + (DRIFT_PER_YEAR[code] ?? 0) * years)),
    ]);
    const sites: [string, number][] = [
      ['site-krp', profile.krpShare],
      ['site-tvl', 1 - profile.krpShare],
    ];
    for (let i = 0; i < loads; i++) {
      const productCode = nextByShare(owedMaterial.get(profile.id)!, mix);
      const siteId = nextByShare(owedSite.get(profile.id)!, sites);
      const units = Math.round(uniform(profile.load[0], profile.load[1]) * 10) / 10;
      const rate = (LIST_RATE[productCode] ?? 5000) * profile.rateFactor * price * uniform(0.97, 1.03);
      const key = `${date}|${profile.id}|${productCode}|${siteId}`;
      const draft = drafts.get(key) ?? { date, customerId: profile.id, productCode, siteId, units: 0, rupees: 0 };
      draft.units += units;
      draft.rupees += units * rate;
      drafts.set(key, draft);
    }
  }
});

/* ------------------------------------------------- agree with the dashboard */

const all = [...drafts.values()];
const dashboardDays = new Map(DAILY.map((d) => [d.date, d]));
const inDashboard = all.filter((d) => dashboardDays.has(d.date));
const sum = (rows: Draft[], f: (d: Draft) => number) => rows.reduce((s, d) => s + f(d), 0);

// One level for the whole history, so the last 30 days do not step away from the rest.
const unitScale = DAILY.reduce((s, d) => s + d.dispatchedUnits, 0) / sum(inDashboard, (d) => d.units);
const dashboardRate = DAILY.reduce((s, d) => s + d.revenue, 0) / DAILY.reduce((s, d) => s + d.dispatchedUnits, 0);
const priceScale = dashboardRate / (sum(inDashboard, (d) => d.rupees) / sum(inDashboard, (d) => d.units));

interface Whole {
  line: Omit<SaleLine, 'units' | 'value'>;
  tenths: number;
  paise: number;
}

const wholes: Whole[] = all.map((d) => ({
  line: { date: d.date, customerId: d.customerId, productCode: d.productCode, siteId: d.siteId },
  tenths: Math.max(1, Math.round(d.units * unitScale * 10)),
  paise: Math.round(d.rupees * unitScale * priceScale * 100),
}));

/**
 * Each dashboard day scaled to its exact units and rupees. What rounding
 * leaves over goes to the day's biggest line, so the day adds up to the tenth
 * of a unit and to the paisa.
 */
function settle(lines: Whole[], tenths: number, paise: number) {
  if (lines.length === 0) return;
  const t0 = lines.reduce((s, l) => s + l.tenths, 0);
  const p0 = lines.reduce((s, l) => s + l.paise, 0);
  for (const l of lines) {
    l.tenths = Math.max(1, Math.round((l.tenths * tenths) / t0));
    l.paise = Math.round((l.paise * paise) / p0);
  }
  const biggest = lines.reduce((a, b) => (b.tenths > a.tenths ? b : a));
  biggest.tenths += tenths - lines.reduce((s, l) => s + l.tenths, 0);
  biggest.paise += paise - lines.reduce((s, l) => s + l.paise, 0);
}

for (const day of DAILY) {
  settle(
    wholes.filter((w) => w.line.date === day.date),
    Math.round(day.dispatchedUnits * 10),
    Math.round(day.revenue * 100),
  );
}

/** Oldest first; within a day by customer, material, site. */
export const SALES_HISTORY: SaleLine[] = wholes
  .map((w) => ({ ...w.line, units: w.tenths / 10, value: paiseToRupees(w.paise) }))
  .sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.customerId.localeCompare(b.customerId) ||
      a.productCode.localeCompare(b.productCode) ||
      a.siteId.localeCompare(b.siteId),
  );

/**
 * What sold over the dashboard's 30 days, in units, biggest first — the
 * dashboard's "What sold" bar, read from the same history as Sales trends so
 * the two screens tell one story.
 */
export const PRODUCT_MIX: { code: string; label: string; units: number }[] = PRODUCTS.map((p) => ({
  code: p.code,
  label: p.label,
  units: Math.round(
    SALES_HISTORY.filter((l) => l.productCode === p.code && dashboardDays.has(l.date)).reduce((s, l) => s + l.units, 0),
  ),
})).sort((a, b) => b.units - a.units);
