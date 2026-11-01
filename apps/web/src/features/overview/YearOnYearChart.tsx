import { AxisLabels, ChartFrame, GridLines, labelWidth, linearScale, niceDomain, ticks } from '@linck/ui';

export interface YearPoint {
  label: string;
  now: number;
  /** Null where the history does not reach back a year. */
  lastYear: number | null;
}

/**
 * This year against last year, as two lines over the same buckets.
 *
 * Built from the design system's chart parts rather than a second trend
 * chart: `TrendChart` draws one series, and this screen's whole question is
 * the gap between two. This year is the solid ink line; last year is lighter
 * and dashed, because it is the reference, not the news. The key sits above
 * the plot in plain text instead of at the line ends — two direct labels in
 * Tamil leave a 375px phone about 150px of plot, and where the lines end
 * close together the labels print on top of each other.
 *
 * The axis starts at zero, so a 10% gap looks like 10%.
 *
 * Tapping or hovering a bucket marks it; the screen prints its figures in a
 * line under the chart, where they can wrap — an SVG tooltip cannot.
 */
export function YearOnYearChart({
  data,
  summary,
  format,
  active,
  onActive,
  height = 200,
}: {
  data: YearPoint[];
  summary: string;
  format: (value: number) => string;
  active: number;
  onActive: (index: number) => void;
  height?: number;
}) {
  const values = data.flatMap((d) => (d.lastYear === null ? [d.now] : [d.now, d.lastYear]));
  const domain = niceDomain(values);
  const grid = ticks(domain, 3);
  // The value labels sit in the right gutter, so it is as wide as the widest
  // of them: "₹50.00 லட்சம்" needs far more room than "₹50.00 L".
  const padRight = Math.max(58, Math.ceil(Math.max(...grid.map((v) => labelWidth(format(v), 5.9)))) + 12);

  return (
    <ChartFrame summary={summary} height={height} padLeft={4} padRight={padRight} padBottom={24}>
      {(box) => {
        const y = linearScale(domain, [box.y1, box.y0]);
        const step = data.length > 1 ? box.width / (data.length - 1) : 0;
        const px = (i: number) => box.x0 + i * step;

        const nowPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${px(i)},${y(d.now)}`).join(' ');
        // Last year breaks where the history has no record, instead of
        // drawing a line across months nobody wrote down.
        let pen = false;
        const beforePath = data
          .map((d, i) => {
            if (d.lastYear === null) {
              pen = false;
              return '';
            }
            const move = pen ? 'L' : 'M';
            pen = true;
            return `${move}${px(i)},${y(d.lastYear)}`;
          })
          .join(' ');
        const point = data[active];

        return (
          <>
            <GridLines box={box} scale={y} values={grid} />
            {grid.map((v) => (
              <text
                key={v}
                x={box.x1 + 6}
                y={y(v)}
                fontSize={11}
                fill="var(--text-tertiary)"
                dominantBaseline="middle"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {format(v)}
              </text>
            ))}

            <path d={beforePath} fill="none" stroke="var(--chart-3)" strokeWidth={1.5} strokeDasharray="5 4" strokeLinejoin="round" />
            <path d={nowPath} fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

            {data.length <= 16
              ? data.map((d, i) => <circle key={`dot-${i}`} cx={px(i)} cy={y(d.now)} r={2.5} fill="var(--chart-1)" />)
              : null}

            {point ? (
              <g pointerEvents="none">
                <line x1={px(active)} x2={px(active)} y1={box.y0} y2={box.y1} stroke="var(--border-strong)" strokeWidth={1} />
                {point.lastYear !== null ? (
                  <circle cx={px(active)} cy={y(point.lastYear)} r={3.5} fill="var(--surface)" stroke="var(--chart-3)" strokeWidth={1.5} />
                ) : null}
                <circle cx={px(active)} cy={y(point.now)} r={4} fill="var(--chart-1)" stroke="var(--surface)" strokeWidth={1.5} />
              </g>
            ) : null}

            <AxisLabels box={box} labels={data.map((d) => d.label)} every={Math.max(1, Math.ceil(data.length / 6))} />

            {/* One band per bucket, full height: a target a thumb can find. */}
            {data.map((d, i) => (
              <rect
                key={`hit-${d.label}-${i}`}
                x={px(i) - Math.max(step, 12) / 2}
                y={box.y0}
                width={Math.max(step, 12)}
                height={box.height}
                fill="transparent"
                onMouseEnter={() => onActive(i)}
                onClick={() => onActive(i)}
                style={{ cursor: 'pointer' }}
              />
            ))}
          </>
        );
      }}
    </ChartFrame>
  );
}

/** The key above the chart: a solid stroke for this year, a dashed one for last. */
export function YearKey({ thisYear, lastYear }: { thisYear: string; lastYear: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 pb-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
      <span className="inline-flex items-center gap-2">
        <svg width="22" height="8" aria-hidden="true">
          <line x1="1" x2="21" y1="4" y2="4" stroke="var(--chart-1)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        {thisYear}
      </span>
      <span className="inline-flex items-center gap-2">
        <svg width="22" height="8" aria-hidden="true">
          <line x1="1" x2="21" y1="4" y2="4" stroke="var(--chart-3)" strokeWidth="1.5" strokeDasharray="5 4" />
        </svg>
        {lastYear}
      </span>
    </div>
  );
}
