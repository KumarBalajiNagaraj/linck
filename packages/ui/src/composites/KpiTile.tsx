import { cn } from '../lib/cn.js';

/**
 * KPI TILE — no card, no border box, no shadow.
 *
 * Four stacked parts: an italic eyebrow, the number at weight 400 (restraint
 * IS the elevation), a delta line, and an as-of + source stamp.
 *
 * Coloured tile backgrounds are BANNED. A green revenue tile beside a red
 * cost tile makes an executive dashboard look like a slot machine and spends
 * the colour budget the real alerts need.
 */

export interface KpiTileProps {
  /** Newsreader italic caption. A book caption, not an uppercase UI label. */
  eyebrow: string;
  value: string;
  /** Exactly one hero tile per screen — the cash position. */
  hero?: boolean | undefined;
  delta?:
    | {
        text: string;
        /** Colour is spent only when the delta crosses its configured threshold. */
        tone?: 'neutral' | 'attention' | 'critical' | undefined;
      }
    | undefined;
  /**
   * Required, not a nicety. Where a tile is not derived from the ledger —
   * fleet uptime, utilisation, GPS distance — the stamp names the real source,
   * so nobody goes hunting for uptime inside accounting.
   */
  asOf: string;
  source: string;
  freshness?: 'live' | 'materialised' | 'stale' | undefined;
  title?: string | undefined;
  className?: string | undefined;
}

export function KpiTile({ eyebrow, value, hero, delta, asOf, source, freshness = 'live', title, className }: KpiTileProps) {
  const deltaColor =
    delta?.tone === 'critical'
      ? 'var(--status-critical)'
      : delta?.tone === 'attention'
        ? 'var(--status-attention)'
        : 'var(--text-secondary)';

  return (
    <div className={cn('flex flex-col gap-1 px-7 py-6', className)}>
      <span className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
        {eyebrow}
      </span>
      <span
        className="kpi-value num tabular-nums leading-[1.1]"
        style={{
          fontSize: hero ? '2.5rem' : '2rem',
          fontWeight: hero ? 600 : 400,
          letterSpacing: '-0.02em',
          color: 'var(--text-primary)',
        }}
        title={title}
      >
        {value}
      </span>
      {delta ? (
        <span className="num text-[12px] tabular-nums" style={{ color: deltaColor }}>
          {delta.text}
        </span>
      ) : null}
      <AsOfStamp asOf={asOf} source={source} freshness={freshness} />
    </div>
  );
}

/**
 * THE AS-OF STAMP — signature move #5, paired with the 8% chromatic budget.
 *
 * The smallest type on the screen and the most trust-bearing thing on it.
 * The freshness dot: solid = live query, hollow = materialised view,
 * hatched = stale beyond its SLA.
 */
export function AsOfStamp({
  asOf,
  source,
  freshness = 'live',
  className,
}: {
  asOf: string;
  source: string;
  freshness?: 'live' | 'materialised' | 'stale' | undefined;
  className?: string | undefined;
}) {
  // All three branches set the same properties — a tile that goes stale
  // re-renders this same dot, and a branch that omitted one would leave the
  // previous freshness painted underneath.
  const dot: React.CSSProperties =
    freshness === 'live'
      ? { backgroundColor: 'var(--text-tertiary)', backgroundImage: 'none', boxShadow: 'none' }
      : freshness === 'materialised'
        ? {
            backgroundColor: 'transparent',
            backgroundImage: 'none',
            boxShadow: 'inset 0 0 0 1px var(--text-tertiary)',
          }
        : {
            backgroundColor: 'transparent',
            backgroundImage: 'repeating-linear-gradient(45deg, var(--status-attention) 0 1px, transparent 1px 2px)',
            boxShadow: 'none',
          };

  return (
    <span
      className={cn('font-id mt-1 inline-flex items-center gap-1.5 text-[11px] uppercase', className)}
      style={{ color: 'var(--text-tertiary)' }}
      title={
        freshness === 'live'
          ? 'Computed live from the ledger'
          : freshness === 'materialised'
            ? 'From a materialised view'
            : 'Stale beyond its refresh window'
      }
    >
      {/* `shrink-0`, because this is a flex item with an intrinsic 4px width.
          Where the stamp wrapped — a narrow phone header — the dot was the only
          thing that could give, and it was squashed to a 2px tick that read as
          a rendering artefact rather than a freshness signal. */}
      <span aria-hidden="true" className="block h-1 w-1 shrink-0 rounded-full" style={dot} />
      As of {asOf} IST · {source}
    </span>
  );
}
