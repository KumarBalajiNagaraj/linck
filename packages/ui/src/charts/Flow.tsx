import { useState } from 'react';
import { ChartFrame } from './core.js';

export interface FlowOutput {
  label: string;
  value: number;
  /** Expected share, if there is one. The variance against it is the finding. */
  expectedPct?: number;
}

/**
 * YIELD FLOW — one input splitting into many co-products.
 *
 * Crushing is JOINT PRODUCTION, not a bill of materials: a lorry of boulders
 * becomes M-Sand and P-Sand and 20mm and dust all at once, in proportions the
 * plant only partly controls. A bar chart of the outputs loses the thing that
 * matters — that they came from one input and must add up to it.
 *
 * So this draws the split: one trunk on the left, one ribbon per co-product,
 * each sized by tonnage, plus an explicit LOSS ribbon. The loss is drawn, not
 * omitted, because unaccounted material is the finding, not a rounding error.
 *
 * Ribbons are ordered largest first so the eye lands on the main product, and
 * each is labelled in place — no legend.
 */
export function YieldFlow({
  inputLabel,
  inputValue,
  outputs,
  lossLabel = 'Unaccounted',
  summary,
  height = 260,
  format = (v) => `${Math.round(v * 10) / 10}`,
  unit = 't',
}: {
  inputLabel: string;
  inputValue: number;
  outputs: FlowOutput[];
  lossLabel?: string;
  summary: string;
  height?: number;
  format?: (v: number) => string;
  unit?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const outTotal = outputs.reduce((s, o) => s + o.value, 0);
  const loss = Math.max(0, inputValue - outTotal);
  const ordered = [...outputs].sort((a, b) => b.value - a.value);
  const lanes = loss > 0.0001 ? [...ordered, { label: lossLabel, value: loss }] : ordered;

  return (
    <ChartFrame summary={summary} height={height} padLeft={4} padRight={4} padTop={6} padBottom={6}>
      {(box) => {
        const trunkW = 26;
        const trunkX = box.x0 + 74;
        const laneX = box.x1 - 210;
        const gap = 6;
        const totalGap = gap * (lanes.length - 1);
        const scale = (box.height - totalGap) / Math.max(inputValue, outTotal + loss);

        let cursor = box.y0;
        const trunkH = inputValue * scale + totalGap;

        return (
          <>
            {/* The input trunk */}
            <rect x={trunkX} y={box.y0} width={trunkW} height={trunkH} fill="var(--chart-1)" />
            <text x={trunkX - 8} y={box.y0 + trunkH / 2 - 7} textAnchor="end" fontSize={12} fill="var(--text-primary)">
              {inputLabel}
            </text>
            <text
              x={trunkX - 8}
              y={box.y0 + trunkH / 2 + 8}
              textAnchor="end"
              fontSize={12}
              fill="var(--text-secondary)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {format(inputValue)} {unit}
            </text>

            {lanes.map((lane, i) => {
              const h = Math.max(2, lane.value * scale);
              const y = cursor;
              cursor += h + gap;

              const isLoss = lane.label === lossLabel;
              const fill = isLoss ? 'var(--status-attention)' : `var(--chart-${Math.min(5, i + 1)})`;
              const dim = hover !== null && hover !== lane.label;
              const pct = (lane.value / inputValue) * 100;
              const expected = 'expectedPct' in lane ? (lane as FlowOutput).expectedPct : undefined;
              const drift = expected !== undefined ? pct - expected : undefined;

              // A ribbon: leaves the trunk at its own vertical slot and runs
              // flat to the lane. A cubic curve keeps it readable when the
              // trunk and the lane are far apart vertically.
              const midX = (trunkX + trunkW + laneX) / 2;
              const path = `M${trunkX + trunkW},${y} C${midX},${y} ${midX},${y} ${laneX},${y}
                            L${laneX},${y + h} C${midX},${y + h} ${midX},${y + h} ${trunkX + trunkW},${y + h} Z`;

              return (
                <g
                  key={lane.label}
                  opacity={dim ? 0.35 : 1}
                  onMouseEnter={() => setHover(lane.label)}
                  onMouseLeave={() => setHover(null)}
                  style={{ transition: 'opacity var(--dur-state) var(--ease)' }}
                >
                  <path d={path} fill={fill} opacity={isLoss ? 0.55 : 0.85} />
                  <rect x={laneX} y={y} width={10} height={h} fill={fill} />
                  <text x={laneX + 18} y={y + h / 2 - (h > 22 ? 6 : 0)} fontSize={12} fill="var(--text-primary)" dominantBaseline="middle">
                    {lane.label}
                  </text>
                  {h > 22 ? (
                    <text
                      x={laneX + 18}
                      y={y + h / 2 + 9}
                      fontSize={11}
                      fill={drift !== undefined && Math.abs(drift) > 3 ? 'var(--status-attention)' : 'var(--text-tertiary)'}
                      dominantBaseline="middle"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {format(lane.value)} {unit} · {Math.round(pct * 10) / 10}%
                      {drift !== undefined ? ` (${drift >= 0 ? '+' : ''}${Math.round(drift * 10) / 10} vs usual)` : ''}
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
