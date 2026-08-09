import { useState } from 'react';
import {
  AxisLabels,
  ChartFrame,
  DirectLabel,
  GridLines,
  linearScale,
  niceDomain,
  ReferenceLine,
  ticks,
  type PlotBox,
} from './core.js';

export interface TrendPoint {
  label: string;
  value: number;
}

export interface TrendChartProps {
  data: TrendPoint[];
  summary: string;
  height?: number;
  /** Dashed reference: a benchmark km/l, a safety stock level, a target margin. */
  benchmark?: { value: number; label: string };
  /** Shaded acceptable range. Drawn behind everything, in the brand tint. */
  band?: { from: number; to: number };
  /** Trailing label naming the series — the replacement for a legend. */
  seriesLabel?: string;
  format?: (value: number) => string;
  /** Points beyond this fire the attention colour and a ring. */
  flagBelow?: number;
  flagAbove?: number;
}

/**
 * A line over time, with an optional benchmark and an acceptable band.
 *
 * This is the workhorse: km/l against the vehicle's benchmark, daily dispatch
 * against plan, yield against the usual mix, collection days over the quarter.
 *
 * Points that cross a threshold get a filled ring AND the attention colour —
 * two channels, because a colour-blind fleet supervisor still has to see which
 * day the mileage fell off.
 */
export function TrendChart({
  data,
  summary,
  height = 180,
  benchmark,
  band,
  seriesLabel,
  format = (v) => String(Math.round(v * 100) / 100),
  flagBelow,
  flagAbove,
}: TrendChartProps) {
  const [hover, setHover] = useState<number | null>(null);

  const values = data.map((d) => d.value);
  const extras = [
    ...(benchmark ? [benchmark.value] : []),
    ...(band ? [band.from, band.to] : []),
  ];
  const domain = niceDomain([...values, ...extras], { zeroFloor: false });

  return (
    <ChartFrame summary={summary} height={height} padLeft={4} padRight={seriesLabel ? 96 : 44} padBottom={24}>
      {(box) => {
        const y = linearScale(domain, [box.y1, box.y0]);
        const step = data.length > 1 ? box.width / (data.length - 1) : 0;
        const px = (i: number) => box.x0 + i * step;
        const grid = ticks(domain, 3);

        const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${px(i)},${y(d.value)}`).join(' ');
        const active = hover !== null ? data[hover] : undefined;

        return (
          <>
            {band ? (
              <rect
                x={box.x0}
                y={y(band.to)}
                width={box.width}
                height={Math.max(1, y(band.from) - y(band.to))}
                fill="var(--brand-tint)"
              />
            ) : null}

            <GridLines box={box} scale={y} values={grid} />

            {/* The direct label and the axis ticks share the right gutter, so
                the tick sitting under the label is dropped rather than printed
                on top of it. The gridline itself stays, and the value is still
                readable off the ticks above and below. */}
            {grid.map((v) => {
              const clashesWithSeriesLabel =
                // 14 ≈ one 11px line box. Anything closer than a full line
                // height and the two strings share pixels.
                seriesLabel !== undefined && Math.abs(y(v) - y(data[data.length - 1]?.value ?? 0)) < 14;
              if (clashesWithSeriesLabel) return null;
              return (
                <text key={v} x={box.x1 + 6} y={y(v)} fontSize={11} fill="var(--text-tertiary)" dominantBaseline="middle" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {format(v)}
                </text>
              );
            })}

            {benchmark ? <ReferenceLine box={box} y={y(benchmark.value)} label={benchmark.label} /> : null}

            <path d={path} fill="none" stroke="var(--chart-1)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />

            {data.map((d, i) => {
              const flagged =
                (flagBelow !== undefined && d.value < flagBelow) || (flagAbove !== undefined && d.value > flagAbove);
              const isHover = hover === i;
              if (!flagged && !isHover && data.length > 24) return null;
              return (
                <circle
                  key={`${d.label}-${i}`}
                  cx={px(i)}
                  cy={y(d.value)}
                  r={isHover ? 4 : flagged ? 3.5 : 2.5}
                  fill={flagged ? 'var(--status-attention)' : 'var(--chart-1)'}
                  stroke="var(--surface)"
                  strokeWidth={flagged || isHover ? 1.5 : 0}
                />
              );
            })}

            {seriesLabel ? (
              <DirectLabel x={box.x1 + 6} y={y(data[data.length - 1]?.value ?? 0)} color="var(--chart-1)">
                {seriesLabel}
              </DirectLabel>
            ) : null}

            <AxisLabels box={box} labels={data.map((d) => d.label)} every={Math.max(1, Math.ceil(data.length / 6))} />

            {/* One transparent band per point — a bigger hit target than the
                2.5px dot, so hovering works with a real mouse on a real desk. */}
            {data.map((d, i) => (
              <rect
                key={`hit-${d.label}-${i}`}
                x={px(i) - step / 2}
                y={box.y0}
                width={Math.max(step, 8)}
                height={box.height}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            ))}

            {active ? (
              <g pointerEvents="none">
                <line x1={px(hover!)} x2={px(hover!)} y1={box.y0} y2={box.y1} stroke="var(--border-strong)" strokeWidth={1} />
                <text
                  x={px(hover!) < box.x0 + box.width / 2 ? px(hover!) + 8 : px(hover!) - 8}
                  y={box.y0 + 4}
                  textAnchor={px(hover!) < box.x0 + box.width / 2 ? 'start' : 'end'}
                  fontSize={12}
                  fill="var(--text-primary)"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {active.label} · {format(active.value)}
                </text>
              </g>
            ) : null}
          </>
        );
      }}
    </ChartFrame>
  );
}

/**
 * Sparkline — 48×16 of hairline trend, for a KPI tile or a table cell.
 *
 * No axes, no labels, no interaction. It answers "which way and how steadily",
 * and anything more belongs in a real chart.
 */
export function Sparkline({
  data,
  width = 64,
  height = 18,
  benchmark,
  tone = 'chart',
}: {
  data: number[];
  width?: number;
  height?: number;
  benchmark?: number;
  tone?: 'chart' | 'attention' | 'critical';
}) {
  if (data.length < 2) return null;
  const domain = niceDomain(benchmark !== undefined ? [...data, benchmark] : data, { zeroFloor: false });
  const y = linearScale(domain, [height - 2, 2]);
  const step = (width - 2) / (data.length - 1);
  const path = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${1 + i * step},${y(v)}`).join(' ');
  const stroke =
    tone === 'critical' ? 'var(--status-critical)' : tone === 'attention' ? 'var(--status-attention)' : 'var(--chart-2)';

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ display: 'block' }}>
      {benchmark !== undefined ? (
        <line x1={0} x2={width} y1={y(benchmark)} y2={y(benchmark)} stroke="var(--chart-datum)" strokeWidth={1} strokeDasharray="2 2" />
      ) : null}
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A stacked proportion bar — the honest replacement for a pie or donut.
 *
 * A pie makes people compare angles, which they are bad at. A single stacked
 * bar with the segments labelled in place makes it a length comparison, which
 * they are good at, and it costs a fraction of the vertical space on a dense
 * board.
 */
export function ProportionBar({
  segments,
  summary,
  height = 34,
  showLabels = true,
}: {
  segments: { label: string; value: number; tone?: string }[];
  summary: string;
  height?: number;
  showLabels?: boolean;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;

  return (
    <ChartFrame summary={summary} height={showLabels ? height + 20 : height} padLeft={0} padRight={0} padTop={0} padBottom={showLabels ? 20 : 0}>
      {(box: PlotBox) => {
        let cursor = box.x0;
        return (
          <>
            {segments.map((seg, i) => {
              const w = (seg.value / total) * box.width;
              const x = cursor;
              cursor += w;
              const fill = seg.tone ?? `var(--chart-${Math.min(5, i + 1)})`;

              // A segment is labelled only with what actually FITS it.
              //
              // The old test was a flat `w > 46`, which passed a 60px segment
              // and then let "Expired or lapsed 10%" run 50px into its
              // neighbour — on a six-segment bar the right-hand labels merged
              // into one unreadable string. Falling back to the bare
              // percentage keeps every segment quantified in place; the name
              // that no longer fits is carried by the summary, which lists all
              // of them.
              const pct = `${Math.round((seg.value / total) * 100)}%`;
              const full = `${seg.label} ${pct}`;
              const room = (s: string) => {
                const need = s.length * 5.9 + 8;
                return w >= need && x + need <= box.x1;
              };
              const text = room(full) ? full : room(pct) ? pct : null;

              return (
                <g key={seg.label}>
                  <rect x={x} y={box.y0} width={Math.max(0, w - 1)} height={box.height} fill={fill} />
                  {showLabels && text !== null ? (
                    <text
                      x={x + 6}
                      y={box.y1 + 13}
                      fontSize={11}
                      fill="var(--text-secondary)"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {text}
                    </text>
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
