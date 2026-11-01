/**
 * Exact decimal arithmetic for money, on decimal strings.
 *
 * Money crosses the wire as a string ("41277.60", see money.ts) and must never
 * pass through a JS number in arithmetic: 0.1 + 0.2 is not 0.3, and a trip's
 * profit summed over a month of loads drifts by paise in a way nobody can
 * reconstruct. A value here is an integer count of 10^-scale, held in a
 * BigInt, so adding, subtracting and multiplying are exact; only rounding and
 * division lose digits, and both round half away from zero — Python's
 * ROUND_HALF_UP, which the API uses, so the two sides cannot disagree by a
 * paisa (apps/api/app/domain/vehicle_pl.py).
 */

export interface Dec {
  /** The value is `units / 10^scale`. */
  readonly units: bigint;
  readonly scale: number;
}

/** A figure as the wire or a form carries it. */
export type Decimalish = string | number;

const ZERO: Dec = { units: 0n, scale: 0 };
const PLAIN = /^([+-]?)(\d+)(?:\.(\d*))?$|^([+-]?)\.(\d+)$/;

const pow10 = (n: number): bigint => 10n ** BigInt(n);
const abs = (n: bigint): bigint => (n < 0n ? -n : n);

/**
 * A decimal from a string ("12", "-0.50", "1033.33") or a finite JS number
 * (a JSON quantity such as 120.455, read as the shortest decimal that prints
 * back to it). Null for anything else — never a guess.
 */
export function parseDec(value: Decimalish | Dec | null | undefined): Dec | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) >= 1e21) return null;
    text = String(value);
    if (/e/i.test(text)) text = value.toFixed(20);
  } else {
    text = value.trim();
  }
  const m = PLAIN.exec(text);
  if (!m) return null;
  const sign = m[1] ?? m[4] ?? '';
  const whole = m[2] ?? '0';
  const frac = m[3] ?? m[5] ?? '';
  const units = BigInt(whole + frac) * (sign === '-' ? -1n : 1n);
  return { units, scale: frac.length };
}

/** A figure, or zero when it is empty or unreadable: a line not yet filled in counts nothing. */
export function dec(value: Decimalish | Dec | null | undefined): Dec {
  return parseDec(value) ?? ZERO;
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.units * pow10(scale - a.scale), b.units * pow10(scale - b.scale), scale];
}

export function add(a: Dec, b: Dec): Dec {
  const [x, y, scale] = align(a, b);
  return { units: x + y, scale };
}

export function sub(a: Dec, b: Dec): Dec {
  const [x, y, scale] = align(a, b);
  return { units: x - y, scale };
}

export function mul(a: Dec, b: Dec): Dec {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

export function sum(values: readonly Dec[]): Dec {
  return values.reduce(add, ZERO);
}

export function cmp(a: Dec, b: Dec): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function isZero(a: Dec): boolean {
  return a.units === 0n;
}

export function isNegative(a: Dec): boolean {
  return a.units < 0n;
}

/** `a` rounded to `places` decimals, half away from zero. */
export function roundTo(a: Dec, places: number): Dec {
  if (a.scale <= places) return { units: a.units * pow10(places - a.scale), scale: places };
  const divisor = pow10(a.scale - places);
  let q = abs(a.units) / divisor;
  if (2n * (abs(a.units) % divisor) >= divisor) q += 1n;
  return { units: a.units < 0n ? -q : q, scale: places };
}

/** `a × pct / 100`, rounded to `places`: GST on a value, exact until the one rounding. */
export function percentOf(a: Dec, pct: Dec, places = 2): Dec {
  return roundTo({ units: a.units * pct.units, scale: a.scale + pct.scale + 2 }, places);
}

/**
 * `a / b` rounded to `places`, half away from zero, computed on integers so
 * nothing is rounded twice. Throws on division by zero: the caller decides
 * what "no figure" means (a profit % with no sales is null, not zero).
 */
export function divTo(a: Dec, b: Dec, places: number): Dec {
  if (b.units === 0n) throw new RangeError('division by zero');
  const n = a.units * pow10(b.scale + places);
  const d = b.units * pow10(a.scale);
  let q = abs(n) / abs(d);
  if (2n * (abs(n) % abs(d)) >= abs(d)) q += 1n;
  return { units: (n < 0n) !== (d < 0n) ? -q : q, scale: places };
}

/** `"7362.48"`: exactly `places` decimals, never an exponent. */
export function toFixed(a: Dec, places = 2): string {
  const r = roundTo(a, places);
  const digits = abs(r.units).toString().padStart(places + 1, '0');
  const whole = places === 0 ? digits : digits.slice(0, -places);
  const frac = places === 0 ? '' : `.${digits.slice(-places)}`;
  return `${r.units < 0n ? '-' : ''}${whole}${frac}`;
}

/** The shortest exact decimal string: "120.5", "86", "-12.35". */
export function toPlain(a: Dec): string {
  let units = a.units;
  let scale = a.scale;
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  return toFixed({ units, scale }, scale);
}

/** For a JSON quantity on the way out (litres, km, km/L). Exact for the values it is used on. */
export function toNumber(a: Dec): number {
  return Number(toPlain(a));
}

/**
 * Split `total` across `weights` so the parts add up to the total exactly,
 * to `places` decimals: each part is floored, and the units left over go one
 * each to the parts with the largest remainders, the earlier part first on a
 * tie. Negative weights count as zero; when every weight is zero the total is
 * split equally. A diesel fill shared by three trips is ₹5682.01 + ₹4971.75 +
 * ₹3551.25 of a ₹14205.01 bill, never ₹14205.00 or ₹14205.02.
 */
export function allocate(total: Dec, weights: readonly Dec[], places: number): Dec[] {
  if (weights.length === 0) return [];
  const t = roundTo(total, places).units;
  const negative = t < 0n;
  const whole = abs(t);
  const scale = Math.max(...weights.map((w) => w.scale));
  let ws = weights.map((w) => {
    const u = w.units * pow10(scale - w.scale);
    return u > 0n ? u : 0n;
  });
  let sumW = ws.reduce((s, w) => s + w, 0n);
  if (sumW === 0n) {
    ws = ws.map(() => 1n);
    sumW = BigInt(ws.length);
  }
  const floors = ws.map((w) => (whole * w) / sumW);
  const remainders = ws.map((w) => (whole * w) % sumW);
  let left = whole - floors.reduce((s, f) => s + f, 0n);
  const order = remainders
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of order) {
    if (left === 0n) break;
    floors[i] = floors[i]! + 1n;
    left -= 1n;
  }
  return floors.map((f) => ({ units: negative ? -f : f, scale: places }));
}
