import { useState } from 'react';
import { ChartFrame, GridLines, linearScale, niceDomain, ReferenceLine, ticks } from './core.js';

export interface BarDatum {
  label: string;
  value: number;
  /** Overrides the ramp — use ONLY for a status meaning, never for decoration. */
  tone?: string;
  /** A per-bar target: safety stock, benchmark, last period. */
  marker?: number;
  sublabel?: string;
}

/**
 * Horizontal bars, sorted by the caller.
 *
 * Horizontal rather than vertical because ERP categories have long names —
 * "TN Highways Contractor — Kancheepuram", "40mm Aggregate" — and a vertical
 * bar chart with those labels needs 45° rotation, which is a legibility tax
 * paid on every read.
 *
 * The per-bar marker is what makes this useful for stock: the bar is what you
 * have, the tick is the safety level, and the gap between them is the story.
 */
export function BarChart({
  data,
  summary,
  format = (v) => String(Math.round(v)),
  barHeight = 22,
  labelWidth = 150,
  onSelect,
}: {
  data: BarDatum[];
  summary: string;
  format?: (value: number) => string;
  barHeight?: number;
  labelWidth?: number;
  onSelect?: (datum: BarDatum) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const values = data.flatMap((d) => [d.value, d.marker ?? d.value]);
  const domain = niceDomain(values);
  const height = data.length * barHeight + 26;

  return (
    <ChartFrame summary={summary} height={height} padLeft={labelWidth} padRight={64} padTop={4} padBottom={22}>
      {(box) => {
        const x = linearScale(domain, [box.x0, box.x1]);
        const grid = ticks(domain, 4);

        return (
          <>
            <g aria-hidden="true">
              {grid.map((v) => (
                <line key={v} x1={x(v)} x2={x(v)} y1={box.y0} y2={box.y1} stroke="var(--border-subtle)" strokeWidth={1} />
              ))}
            </g>

            {data.map((d, i) => {
              const y = box.y0 + i * barHeight;
              const w = Math.max(1, x(d.value) - box.x0);
              const isHover = hover === d.label;
              return (
                <g
                  key={d.label}
                  onMouseEnter={() => setHover(d.label)}
                  onMouseLeave={() => setHover(null)}
                  onClick={onSelect ? () => onSelect(d) : undefined}
                  style={{ cursor: onSelect ? 'pointer' : 'default' }}
                >
                  <rect x={0} y={y} width={box.x1} height={barHeight} fill={isHover ? 'var(--surface-selected)' : 'transparent'} />
                  <text
                    x={labelWidth - 10}
                    y={y + barHeight / 2}
                    textAnchor="end"
                    fontSize={12}
                    fill="var(--text-primary)"
                    dominantBaseline="middle"
                  >
                    {d.label}
                  </text>
                  <rect x={box.x0} y={y + 4} width={w} height={barHeight - 9} fill={d.tone ?? 'var(--chart-2)'} />
                  {d.marker !== undefined ? (
                    <line
                      x1={x(d.marker)}
                      x2={x(d.marker)}
                      y1={y + 1}
                      y2={y + barHeight - 6}
                      stroke="var(--chart-datum)"
                      strokeWidth={1.5}
                      strokeDasharray="3 2"
                    />
                  ) : null}
                  <text
                    x={box.x1 + 6}
                    y={y + barHeight / 2}
                    fontSize={12}
                    fill="var(--text-secondary)"
                    dominantBaseline="middle"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {format(d.value)}
                  </text>
                </g>
              );
            })}

            <g aria-hidden="true">
              {grid.map((v) => (
                <text key={v} x={x(v)} y={box.y1 + 14} textAnchor="middle" fontSize={11} fill="var(--text-tertiary)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {format(v)}
                </text>
              ))}
            </g>
          </>
        );
      }}
    </ChartFrame>
  );
}

export interface WaterfallStep {
  label: string;
  /** Signed. Positive adds, negative subtracts. */
  delta: number;
  /** Marks a subtotal — drawn from the baseline rather than floating. */
  total?: boolean;
  /**
   * Opt-in, and rare: spends the attention hue on this one step.
   *
   * Reserved for the step that should not be there at all — the unexplained
   * gap, the shrinkage nobody booked. Direction is NOT severity: dispatching
   * a thousand tonnes is the business working, and painting every outflow in
   * the alarm hue leaves the reader with a chart where the healthiest bar
   * shouts loudest and a genuine problem has nothing left to shout with.
   */
  flag?: boolean;
}

/**
 * WATERFALL — opening, plus what came in, minus what went out, equals closing.
 *
 * This is the shape of the single most valuable report in the business:
 * produced vs dispatched vs invoiced, with the reconciling items itemised. The
 * whole point is that the unexplained gap is a BAR, not a footnote — it has the
 * same visual weight as the movements that are accounted for.
 */
export function WaterfallChart({
  steps,
  summary,
  height = 220,
  format = (v) => String(Math.round(v)),
}: {
  steps: WaterfallStep[];
  summary: string;
  height?: number;
  format?: (value: number) => string;
}) {
  // Running totals, so each floating bar knows where to start.
  //
  // A `total` step means two different things depending on where it sits, and
  // conflating them is what makes a waterfall render as nonsense. The FIRST
  // step, if flagged, is an OPENING balance: it seeds the running figure from
  // its own delta. Any later flagged step is a SUBTOTAL: it draws whatever the
  // running figure has reached and ignores its delta entirely.
  let running = 0;
  const computed = steps.map((s, i) => {
    if (s.total) {
      if (i === 0) running = s.delta;
      return { ...s, from: 0, to: running };
    }
    const from = running;
    running += s.delta;
    return { ...s, from, to: running };
  });

  const domain = niceDomain([0, ...computed.flatMap((c) => [c.from, c.to])]);

  return (
    <ChartFrame summary={summary} height={height} padLeft={8} padRight={52} padBottom={38}>
      {(box) => {
        const y = linearScale(domain, [box.y1, box.y0]);
        const slot = box.width / computed.length;
        const barW = Math.min(56, slot * 0.6);
        const grid = ticks(domain, 4);

        return (
          <>
            <GridLines box={box} scale={y} values={grid} />
            {grid.map((v) => (
              <text key={v} x={box.x1 + 6} y={y(v)} fontSize={11} fill="var(--text-tertiary)" dominantBaseline="middle" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {format(v)}
              </text>
            ))}

            {computed.map((c, i) => {
              const cx = box.x0 + slot * i + slot / 2;
              const top = Math.min(y(c.from), y(c.to));
              const h = Math.max(1.5, Math.abs(y(c.to) - y(c.from)));
              // Monochrome ramp by ROLE, not by direction. Subtotals anchor the
              // read so they sit darkest; the movements between them are one
              // step lighter, and the sign is carried by the ±label and by the
              // connector line, which are unambiguous without spending a hue.
              const tone = c.flag
                ? 'var(--status-attention)'
                : c.total
                  ? 'var(--chart-1)'
                  : c.delta >= 0
                    ? 'var(--chart-3)'
                    : 'var(--chart-2)';

              return (
                <g key={`${c.label}-${i}`}>
                  <rect x={cx - barW / 2} y={top} width={barW} height={h} fill={tone} />
                  {i < computed.length - 1 ? (
                    <line
                      x1={cx + barW / 2}
                      x2={cx + slot - barW / 2}
                      y1={y(c.to)}
                      y2={y(c.to)}
                      stroke="var(--border-strong)"
                      strokeWidth={1}
                      strokeDasharray="2 2"
                    />
                  ) : null}
                  <text x={cx} y={top - 5} textAnchor="middle" fontSize={11} fill="var(--text-primary)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {c.total ? format(c.to) : `${c.delta >= 0 ? '+' : ''}${format(c.delta)}`}
                  </text>
                  <text x={cx} y={box.y1 + 14} textAnchor="middle" fontSize={11} fill="var(--text-tertiary)">
                    {c.label}
                  </text>
                </g>
              );
            })}

            <ReferenceLine box={box} y={y(0)} />
          </>
        );
      }}
    </ChartFrame>
  );
}

/**
 * AGEING BUCKETS — a stacked horizontal bar where the buckets are ordered and
 * the later ones matter more.
 *
 * Used for receivables and for anything else with a clock on it: the extraction
 * queue, unverified receipts, indents waiting on approval. The ramp darkens
 * with age rather than turning red, so the 8% chromatic budget stays intact and
 * the reader still sees which end is the problem.
 */
export function AgeingBar({
  buckets,
  summary,
  format,
  height = 56,
}: {
  buckets: { label: string; value: number }[];
  summary: string;
  format: (value: number) => string;
  height?: number;
}) {
  const total = buckets.reduce((s, b) => s + b.value, 0) || 1;

  return (
    <ChartFrame summary={summary} height={height} padLeft={0} padRight={0} padTop={0} padBottom={30}>
      {(box) => {
        let cursor = box.x0;
        return (
          <>
            {buckets.map((b, i) => {
              const w = (b.value / total) * box.width;
              const x = cursor;
              cursor += w;
              // Later buckets sit later in the ramp, so "older" reads as
              // "heavier" without spending a status hue on it.
              const fill = `var(--chart-${Math.min(5, i + 1)})`;
              return (
                <g key={b.label}>
                  <rect x={x} y={box.y0} width={Math.max(0, w - 1)} height={box.height} fill={fill} />
                  {w > 54 ? (
                    <>
                      <text x={x + 6} y={box.y1 + 12} fontSize={11} fill="var(--text-secondary)">
                        {b.label}
                      </text>
                      <text x={x + 6} y={box.y1 + 25} fontSize={11} fill="var(--text-primary)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {format(b.value)}
                      </text>
                    </>
                  ) : null}
                </g>
              );
            })}
          </>
        );
      }}
    </ChartFrame>
  );
}
