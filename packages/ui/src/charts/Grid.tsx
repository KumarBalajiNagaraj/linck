import { useState } from 'react';
import { ChartFrame, linearScale, niceDomain, ReferenceLine } from './core.js';

export interface HeatCell {
  row: string;
  col: string;
  /** 0..1 after the caller normalises. Null renders as an explicit blank. */
  intensity: number | null;
  title?: string;
  /** Overrides the ramp for a categorical meaning: absent, on leave, breakdown. */
  tone?: string;
}

/**
 * HEAT GRID — driver attendance across a month, expiries across a quarter,
 * plant running hours by shift.
 *
 * Intensity uses the monochrome ramp, so it never competes with a status hue.
 * A null cell renders as a hairline outline rather than the lightest shade,
 * because "nobody recorded anything" and "recorded as zero" are different
 * facts and must not look the same — the same rule the tables follow with the
 * en dash.
 */
export function HeatGrid({
  cells,
  rows,
  cols,
  summary,
  cellSize = 16,
  rowLabelWidth = 130,
  onSelect,
}: {
  cells: HeatCell[];
  rows: string[];
  cols: string[];
  summary: string;
  cellSize?: number;
  rowLabelWidth?: number;
  onSelect?: (cell: HeatCell) => void;
}) {
  const [hover, setHover] = useState<HeatCell | null>(null);
  const gap = 2;
  const height = rows.length * (cellSize + gap) + 34;
  const index = new Map(cells.map((c) => [`${c.row}|${c.col}`, c]));

  return (
    <ChartFrame summary={summary} height={height} padLeft={rowLabelWidth} padRight={4} padTop={18} padBottom={8}>
      {(box) => {
        const cw = Math.max(4, (box.width - gap * (cols.length - 1)) / cols.length);
        return (
          <>
            {cols.map((col, ci) =>
              ci % Math.max(1, Math.ceil(cols.length / 12)) === 0 ? (
                <text key={col} x={box.x0 + ci * (cw + gap)} y={box.y0 - 6} fontSize={10} fill="var(--text-tertiary)">
                  {col}
                </text>
              ) : null,
            )}

            {rows.map((row, ri) => (
              <g key={row}>
                <text
                  x={rowLabelWidth - 10}
                  y={box.y0 + ri * (cellSize + gap) + cellSize / 2}
                  textAnchor="end"
                  fontSize={12}
                  fill="var(--text-primary)"
                  dominantBaseline="middle"
                >
                  {row}
                </text>
                {cols.map((col, ci) => {
                  const cell = index.get(`${row}|${col}`);
                  const x = box.x0 + ci * (cw + gap);
                  const y = box.y0 + ri * (cellSize + gap);
                  const empty = !cell || cell.intensity === null;
                  return (
                    <rect
                      key={col}
                      x={x}
                      y={y}
                      width={cw}
                      height={cellSize}
                      rx={1}
                      fill={
                        empty
                          ? 'transparent'
                          : (cell?.tone ??
                            `var(--chart-${Math.min(5, Math.max(1, 6 - Math.ceil((cell?.intensity ?? 0) * 5)))})`)
                      }
                      stroke={empty ? 'var(--border-default)' : 'none'}
                      strokeDasharray={empty ? '2 2' : undefined}
                      onMouseEnter={() => cell && setHover(cell)}
                      onMouseLeave={() => setHover(null)}
                      onClick={onSelect && cell ? () => onSelect(cell) : undefined}
                      style={{ cursor: onSelect ? 'pointer' : 'default' }}
                    >
                      <title>{cell?.title ?? `${row} · ${col} · not recorded`}</title>
                    </rect>
                  );
                })}
              </g>
            ))}

            {hover ? (
              <text x={box.x0} y={box.y1 + 6} fontSize={11} fill="var(--text-secondary)">
                {hover.title ?? `${hover.row} · ${hover.col}`}
              </text>
            ) : null}
          </>
        );
      }}
    </ChartFrame>
  );
}

export interface ScatterPoint {
  x: number;
  y: number;
  label: string;
  flagged?: boolean;
}

/**
 * SCATTER — the shape that finds the outlier.
 *
 * Built for the diesel question: km/l against the vehicle's benchmark, one dot
 * per tipper. A table of sixty rows hides the three that dropped 18%; a scatter
 * with a diagonal parity line makes them the only dots below it.
 *
 * Flagged points get a ring AND a label, never colour alone.
 */
export function ScatterPlot({
  points,
  summary,
  xLabel,
  yLabel,
  height = 240,
  parityLine,
  format = (v) => String(Math.round(v * 100) / 100),
}: {
  points: ScatterPoint[];
  summary: string;
  xLabel: string;
  yLabel: string;
  height?: number;
  /** Draws y = x, the "met its benchmark" line. */
  parityLine?: boolean;
  format?: (v: number) => string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const xd = niceDomain(points.map((p) => p.x), { zeroFloor: false });
  const yd = niceDomain(points.map((p) => p.y), { zeroFloor: false });

  return (
    <ChartFrame summary={summary} height={height} padLeft={44} padRight={16} padTop={24} padBottom={34}>
      {(box) => {
        const x = linearScale(xd, [box.x0, box.x1]);
        const y = linearScale(yd, [box.y1, box.y0]);

        // LABEL PLACEMENT.
        //
        // Every flagged point keeps its ring, so which points are flagged is
        // never in doubt. The NAMES are placed greedily and any name that
        // would collide with one already placed, or spill outside the plot, is
        // dropped — thirteen registrations stacked on top of each other in a
        // 500px box is thirteen unreadable names, which is strictly worse than
        // four readable ones plus a summary that already lists all thirteen.
        // Hovering a point always reveals its own label regardless.
        // Deliberately generous: a width estimate that runs short produces the
        // exact smear this placement exists to prevent, and the cost of being
        // wrong the other way is one dropped label.
        const CHAR_W = 7;
        const LINE_H = 15;
        const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
        const labelAt = new Map<string, { tx: number; anchor: 'start' | 'end' }>();

        for (const p of points) {
          if (!p.flagged) continue;
          const w = p.label.length * CHAR_W;
          const cx = x(p.x);
          const cy = y(p.y);
          // Prefer the right of the dot; flip left when that would overflow.
          const flip = cx + 8 + w > box.x1;
          const x0 = flip ? cx - 8 - w : cx + 8;
          if (x0 < box.x0 || x0 + w > box.x1) continue;
          const rect = { x0, y0: cy - LINE_H / 2, x1: x0 + w, y1: cy + LINE_H / 2 };
          const hits = placed.some((q) => rect.x0 < q.x1 && q.x0 < rect.x1 && rect.y0 < q.y1 && q.y0 < rect.y1);
          if (hits) continue;
          placed.push(rect);
          labelAt.set(p.label, { tx: flip ? cx - 8 : cx + 8, anchor: flip ? 'end' : 'start' });
        }

        return (
          <>
            <line x1={box.x0} x2={box.x1} y1={box.y1} y2={box.y1} stroke="var(--border-strong)" strokeWidth={1} />
            <line x1={box.x0} x2={box.x0} y1={box.y0} y2={box.y1} stroke="var(--border-strong)" strokeWidth={1} />

            {parityLine ? (
              <line
                x1={x(Math.max(xd[0], yd[0]))}
                y1={y(Math.max(xd[0], yd[0]))}
                x2={x(Math.min(xd[1], yd[1]))}
                y2={y(Math.min(xd[1], yd[1]))}
                stroke="var(--chart-datum)"
                strokeWidth={1}
                strokeDasharray="4 3"
              />
            ) : null}

            {points.map((p) => {
              const isHover = hover === p.label;
              return (
                <g key={p.label} onMouseEnter={() => setHover(p.label)} onMouseLeave={() => setHover(null)}>
                  <circle
                    cx={x(p.x)}
                    cy={y(p.y)}
                    r={p.flagged || isHover ? 5 : 3.5}
                    fill={p.flagged ? 'var(--status-attention)' : 'var(--chart-2)'}
                    stroke={p.flagged ? 'var(--surface)' : 'none'}
                    strokeWidth={1.5}
                  />
                  {isHover || labelAt.has(p.label) ? (
                    <text
                      x={labelAt.get(p.label)?.tx ?? x(p.x) + 8}
                      y={y(p.y)}
                      fontSize={11}
                      textAnchor={labelAt.get(p.label)?.anchor ?? 'start'}
                      fill={p.flagged ? 'var(--status-attention)' : 'var(--text-secondary)'}
                      dominantBaseline="middle"
                      style={isHover ? { paintOrder: 'stroke', stroke: 'var(--surface)', strokeWidth: 3 } : undefined}
                    >
                      {p.label}
                    </text>
                  ) : null}
                </g>
              );
            })}

            <text x={box.x1} y={box.y1 + 26} textAnchor="end" fontSize={11} fill="var(--text-tertiary)">
              {xLabel}
            </text>
            {/* Sits ABOVE the plot, clear of the top tick it used to overlap. */}
            <text x={box.x0 - 38} y={box.y0 - 10} fontSize={11} fill="var(--text-tertiary)">
              {yLabel}
            </text>
            <text x={box.x0 - 6} y={box.y1} textAnchor="end" fontSize={11} fill="var(--text-tertiary)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {format(yd[0])}
            </text>
            <text x={box.x0 - 6} y={box.y0 + 4} textAnchor="end" fontSize={11} fill="var(--text-tertiary)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {format(yd[1])}
            </text>
          </>
        );
      }}
    </ChartFrame>
  );
}

/**
 * A gauge against a target, with the shortfall named.
 *
 * Deliberately linear rather than a dial. A dial spends a lot of pixels to
 * encode one number less precisely than a bar, and the two things a reader
 * wants here — where am I, and how far from the target — are both lengths.
 */
export function TargetGauge({
  value,
  target,
  summary,
  format,
  label,
  height = 46,
}: {
  value: number;
  target: number;
  summary: string;
  format: (v: number) => string;
  label?: string;
  height?: number;
}) {
  const domain = niceDomain([0, value, target]);
  const short = value < target;

  return (
    <ChartFrame summary={summary} height={height} padLeft={0} padRight={0} padTop={4} padBottom={20}>
      {(box) => {
        const x = linearScale(domain, [box.x0, box.x1]);
        return (
          <>
            <rect x={box.x0} y={box.y0} width={box.width} height={box.height} fill="var(--surface-sunken)" rx={2} />
            <rect
              x={box.x0}
              y={box.y0}
              width={Math.max(2, x(value) - box.x0)}
              height={box.height}
              fill={short ? 'var(--status-attention)' : 'var(--chart-2)'}
              rx={2}
            />
            <ReferenceLine box={{ ...box, y0: box.y0, y1: box.y1 }} y={box.y0} />
            <line x1={x(target)} x2={x(target)} y1={box.y0 - 3} y2={box.y1 + 3} stroke="var(--text-primary)" strokeWidth={1.5} />
            <text x={box.x0} y={box.y1 + 14} fontSize={11} fill="var(--text-secondary)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {label ? `${label} · ` : ''}
              {format(value)}
            </text>
            <text x={box.x1} y={box.y1 + 14} textAnchor="end" fontSize={11} fill="var(--text-tertiary)" style={{ fontVariantNumeric: 'tabular-nums' }}>
              target {format(target)}
            </text>
          </>
        );
      }}
    </ChartFrame>
  );
}
