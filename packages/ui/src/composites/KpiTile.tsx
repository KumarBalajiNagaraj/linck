import { cn } from '../lib/cn.js';
import { useUiWords } from '../lib/words.js';

/**
 * KPI TILE — no card, no border box, no shadow.
 *
 * Four stacked parts: an italic eyebrow, the number at weight 400 (restraint
 * IS the elevation), a delta line, and an as-of + source stamp — unless the
 * page header's stamp already gives this tile's time (`asOfInHeader`).
 *
 * Coloured tile backgrounds are BANNED. A green revenue tile beside a red
 * cost tile makes an executive dashboard look like a slot machine and spends
 * the colour budget the real alerts need.
 */

interface KpiTileBaseProps {
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
  title?: string | undefined;
  className?: string | undefined;
}

/**
 * Where the tile's time is said.
 *
 * Every figure has a time, so a tile either stamps its own or says, in so many
 * words, that the page header's stamp is its stamp. The second exists because
 * a row of tiles all reading "Updated 14:42" under a header that already says
 * it is four repeats of nothing. A tile whose time differs from the header's —
 * a 06:00 overnight figure — keeps its own, and so does a stale one, because
 * its hatched dot is a warning, not a repeat.
 */
type KpiTileStamp =
  | {
      /**
       * Where a tile is not derived from the ledger — fleet uptime,
       * utilisation, GPS distance — the stamp names the real source, so
       * nobody goes hunting for uptime inside accounting.
       */
      asOf: string;
      source: string;
      freshness?: 'live' | 'materialised' | 'stale' | undefined;
      asOfInHeader?: false | undefined;
    }
  | { asOfInHeader: true; asOf?: undefined; source?: undefined; freshness?: undefined };

export type KpiTileProps = KpiTileBaseProps & KpiTileStamp;

/**
 * A figure and the word after it: "₹26.19 லட்சம்" → "₹26.19" + "லட்சம்".
 * Only a trailing word with no digit in it counts as a unit.
 */
function splitUnit(value: string): [figure: string, unit: string | null] {
  const m = /^(.*\d)\s+(\D+)$/u.exec(value);
  return m ? [m[1]!, m[2]!] : [value, null];
}

export function KpiTile({ eyebrow, value, hero, delta, asOf, source, freshness = 'live', title, className }: KpiTileProps) {
  // The unit word rides smaller than the figure. "₹26.19 L" fitted a
  // quarter-width tile; "₹26.19 லட்சம்" at hero size broke onto two lines,
  // and a screen should not have to move its unit into the eyebrow to stop it.
  const [figure, unit] = splitUnit(value);
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
        {figure}
        {unit !== null ? (
          <span className="ml-[0.25em]" style={{ fontSize: '0.6em', fontWeight: 400, letterSpacing: 'normal' }}>
            {unit}
          </span>
        ) : null}
      </span>
      {delta ? (
        <span className="num text-[12px] tabular-nums" style={{ color: deltaColor }}>
          {delta.text}
        </span>
      ) : null}
      {asOf !== undefined && source !== undefined ? <AsOfStamp asOf={asOf} source={source} freshness={freshness} /> : null}
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
  const words = useUiWords();
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
      className={cn('mt-1 inline-flex items-center gap-1.5 text-[11px]', className)}
      style={{ color: 'var(--text-tertiary)' }}
      // The time is what a person needs; where the figure comes from is for
      // whoever has to trace it, so it is a hover away, not printed in caps.
      title={`${freshness === 'live' ? words.freshness.live : freshness === 'materialised' ? words.freshness.materialised : words.freshness.stale} · ${words.freshness.source(source)}`}
    >
      {/* `shrink-0`, because this is a flex item with an intrinsic 4px width.
          Where the stamp wrapped — a narrow phone header — the dot was the only
          thing that could give, and it was squashed to a 2px tick that read as
          a rendering artefact rather than a freshness signal. */}
      <span aria-hidden="true" className="block h-1 w-1 shrink-0 rounded-full" style={dot} />
      {words.updatedAt(asOf)}
    </span>
  );
}
