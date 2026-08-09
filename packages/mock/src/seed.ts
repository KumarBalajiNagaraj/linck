/**
 * Deterministic seed.
 *
 * A fixed PRNG, not Math.random, so the dashboard shows the same numbers on
 * every reload — a demo where the fleet uptime changes each time you refresh
 * is a demo nobody trusts.
 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

export function between(rng: () => number, min: number, max: number, dp = 0): number {
  const v = min + rng() * (max - min);
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** The clock the whole mock dataset is anchored to. */
export const NOW = new Date('2026-08-08T09:12:00Z'); // 14:42 IST

export function daysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString();
}

export function hoursFromNow(hours: number): string {
  return new Date(NOW.getTime() + hours * 3_600_000).toISOString();
}

export function money(n: number): string {
  return n.toFixed(2);
}
