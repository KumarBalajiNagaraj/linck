/**
 * Money.
 *
 * Amounts cross the wire as decimal STRINGS (FastAPI serialises numeric as a
 * string) and never touch a JS number in arithmetic. Formatting is the only
 * place a number is allowed, and only for display.
 *
 * The MD and the CA disagree about grouping, so the international/Indian
 * toggle is stored on the USER, not the organization.
 */

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INR_0 = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export type MoneyInput = string | number;

function toNumber(v: MoneyInput): number {
  return typeof v === 'number' ? v : Number.parseFloat(v);
}

/** `₹12,34,567.89` — en-IN gives the 2-3-2 lakh grouping natively. */
export function formatINR(value: MoneyInput, opts?: { decimals?: 0 | 2 }): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '–';
  return (opts?.decimals === 0 ? INR_0 : INR).format(n);
}

/**
 * `₹1.23 Cr` / `₹4.50 L` / `₹85.0 K`.
 *
 * Hand-implemented against explicit thresholds rather than trusting ICU's
 * `notation: 'compact'`, whose output for Indian locales is not stable across
 * runtimes — and an executive dashboard that renders "₹1.2Cr" in Chrome and
 * "₹12000000" in a Samsung browser is not a dashboard.
 *
 * Always pair with a `title` carrying the full-precision value.
 */
export function formatINRCompact(value: MoneyInput): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_00_00_000) return `${sign}₹${(abs / 1_00_00_000).toFixed(2)} Cr`;
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(2)} L`;
  if (abs >= 1_000) return `${sign}₹${(abs / 1_000).toFixed(1)} K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

/**
 * Accounting negatives: `(12,450.00)`, rendered in --status-critical.
 * A minus sign in a column of forty numbers is one pixel wide and gets missed.
 */
export function formatAccounting(value: MoneyInput, opts?: { decimals?: 0 | 2 }): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '–';
  const body = formatINR(Math.abs(n), opts).replace('₹', '');
  return n < 0 ? `(${body.trim()})` : body.trim();
}

export function isNegative(value: MoneyInput): boolean {
  const n = toNumber(value);
  return Number.isFinite(n) && n < 0;
}

/**
 * A figure typed by hand, read strictly. "12,500", "12,500.00", "₹ 12500" and
 * the lakh-grouped "1,50,000" all read as written. Anything else — "12.500,00",
 * "12 500", "12,50", three decimals on a rupee amount — is null, never a
 * guess: `parseFloat("12,500")` is 12, and a bill paid as ₹12 is worse than a
 * form that refuses.
 */
export function parseTypedAmount(text: string, maxDecimals = 2): number | null {
  const t = text.trim().replace(/^(?:₹|rs\.?|inr)\s*/i, '');
  const grouped = /^\d{1,3}(?:,\d{2})*,\d{3}(?:\.\d+)?$/.test(t) || /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t);
  if (!grouped && !/^\d+(?:\.\d+)?$/.test(t)) return null;
  if ((t.split('.')[1] ?? '').length > maxDecimals) return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
