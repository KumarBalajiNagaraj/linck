/**
 * CHART FOUNDATION.
 *
 * WHY THESE ARE HAND-BUILT SVG AND NOT A CHARTING LIBRARY.
 *
 * The obvious move is ECharts or similar. Three things argued against it here:
 *
 * 1. THEMING. Every colour in this product is a CSS custom property, and the
 *    user can flip light/dark at any moment. SVG inherits `var(--chart-1)`
 *    natively, so a theme switch costs nothing and cannot drift. A canvas
 *    renderer cannot see CSS variables at all — it needs computed-style reads
 *    and a full theme object rebuilt and re-applied on every toggle, which is
 *    a permanent source of "the chart is still using last theme's colours".
 *
 * 2. THE DESIGN LAWS FIGHT THE DEFAULTS. This system mandates a monochrome
 *    single-hue ramp, direct labelling instead of legends, hairline rules, no
 *    gradients, no drop shadows, tabular figures, and an 8% chromatic budget.
 *    Almost all of that is written as an override against a library's defaults,
 *    and every override is a place the two can disagree.
 *
 * 3. SIZE. ~300KB gzipped for shapes that are, honestly, polylines and rects.
 *
 * The cost is that we own the axis maths. That is the code below, and it is
 * shared by every chart so it can only be wrong in one place.
 *
 * ACCESSIBILITY: a chart is an image with a caption. Each one takes a
 * `summary` that states the finding in words — "uptime 65.5%, four vehicles
 * down" — because a screen-reader user, and an executive skimming, both need
 * the conclusion rather than the geometry.
 */

import { useEffect, useRef, useState } from 'react';

export interface Scale {
  (value: number): number;
  domain: [number, number];
  range: [number, number];
}

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const fn = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as Scale;
  fn.domain = domain;
  fn.range = range;
  return fn;
}

/**
 * A domain that ends on a round number.
 *
 * An axis topping out at 6,847 makes a reader do arithmetic to compare two
 * charts. Rounding to 7,000 costs nothing and makes the gridlines mean
 * something.
 */
export function niceDomain(values: number[], opts?: { zeroFloor?: boolean }): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [0, 1];

  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (opts?.zeroFloor !== false) min = Math.min(0, min);
  if (min === max) {
    max = min + 1;
  }

  const step = niceStep((max - min) / 4);
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step];
}

function niceStep(rough: number): number {
  if (rough <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const nice = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return nice * magnitude;
}

export function ticks(domain: [number, number], count = 4): number[] {
  const [d0, d1] = domain;
  const step = niceStep((d1 - d0) / count);
  const out: number[] = [];
  for (let v = Math.ceil(d0 / step) * step; v <= d1 + step * 0.001; v += step) {
    out.push(Math.abs(v) < step * 0.001 ? 0 : v);
  }
  return out;
}

export interface ChartFrameProps {
  /** Stated finding, not geometry. Read by screen readers and shown on hover. */
  summary: string;
  height?: number;
  /** Reserve room for y-axis labels; set 0 when the chart is direct-labelled instead. */
  padLeft?: number;
  padRight?: number;
  padTop?: number;
  padBottom?: number;
  children: (box: PlotBox) => React.ReactNode;
  className?: string;
}

export interface PlotBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  height: number;
}

/**
 * Measures the container so charts can be drawn in REAL PIXELS.
 *
 * The tempting shortcut is a fixed viewBox plus `preserveAspectRatio="none"`,
 * which fills the container with no measuring at all. It also stretches every
 * glyph horizontally and scales an 11px axis label to whatever the container
 * width happens to imply — so the same label renders at 11px in a side sheet
 * and 17px on a 27-inch dashboard. In a product whose type scale is the
 * hierarchy, that is not a small compromise.
 *
 * Measuring costs one ResizeObserver per chart and buys exact control: text at
 * exactly 11px, rules at exactly 1px, everywhere.
 */
function useContainerWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

/**
 * The shared frame.
 *
 * Reserves its height before it has measured anything, so the page never
 * changes shape between loading and loaded — the same rule the tables follow
 * with their hairlines-and-dashes placeholder.
 */
export function ChartFrame({
  summary,
  height = 180,
  padLeft = 8,
  padRight = 8,
  padTop = 10,
  padBottom = 22,
  children,
  className,
}: ChartFrameProps) {
  const [ref, width] = useContainerWidth();

  const box: PlotBox = {
    x0: padLeft,
    y0: padTop,
    x1: Math.max(padLeft + 1, width - padRight),
    y1: height - padBottom,
    width: Math.max(1, width - padLeft - padRight),
    height: height - padTop - padBottom,
  };

  return (
    <div ref={ref} className={className} style={{ width: '100%', height }}>
      {width > 0 ? (
        <svg
          role="img"
          aria-label={summary}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ display: 'block', overflow: 'visible' }}
        >
          <title>{summary}</title>
          {children(box)}
        </svg>
      ) : null}
    </div>
  );
}

/**
 * Horizontal gridlines only, in the subtle border colour.
 *
 * No vertical grid: the x-axis in these charts is time or category, both of
 * which the labels already carry. A full grid doubles the number of lines on
 * screen to restate something the reader can already see.
 */
export function GridLines({ box, scale, values }: { box: PlotBox; scale: Scale; values: number[] }) {
  return (
    <g aria-hidden="true">
      {values.map((v) => (
        <line
          key={v}
          x1={box.x0}
          x2={box.x1}
          y1={scale(v)}
          y2={scale(v)}
          stroke="var(--border-subtle)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}

/**
 * A labelled reference line — a benchmark, a safety level, a tolerance band
 * edge. Dashed, because a target is an assertion about what should be true,
 * not a measurement of what is.
 */
export function ReferenceLine({
  box,
  y,
  label,
  tone = 'datum',
}: {
  box: PlotBox;
  y: number;
  label?: string;
  tone?: 'datum' | 'attention' | 'critical';
}) {
  const stroke =
    tone === 'critical'
      ? 'var(--status-critical)'
      : tone === 'attention'
        ? 'var(--status-attention)'
        : 'var(--chart-datum)';
  return (
    <g>
      <line
        x1={box.x0}
        x2={box.x1}
        y1={y}
        y2={y}
        stroke={stroke}
        strokeWidth={1}
        strokeDasharray="4 3"
        vectorEffect="non-scaling-stroke"
      />
      {label ? (
        <text x={box.x1} y={y - 4} textAnchor="end" fontSize={11} fill={stroke} style={{ fontVariantNumeric: 'tabular-nums' }}>
          {label}
        </text>
      ) : null}
    </g>
  );
}

/** Axis tick labels along the bottom. Tertiary ink, 11px, never bold. */
export function AxisLabels({
  box,
  labels,
  every = 1,
}: {
  box: PlotBox;
  labels: string[];
  every?: number;
}) {
  const step = labels.length > 1 ? box.width / (labels.length - 1) : 0;

  /*
    `every` thins the ticks by COUNT, which is a proxy for width and stops
    being one the moment the plot narrows. Fourteen days at `every = 3` is
    comfortable on a desk and prints "26 Jul29 Jul" on a 375px phone, because
    three steps of a 230px plot is narrower than the label itself.

    So the count rule proposes and geometry disposes: a tick that would touch
    the last one drawn is dropped. Same rule the stacked bar already uses for
    its segment names — label only what actually fits — and it is inert at
    desk widths, where nothing collides in the first place.
  */
  const CHAR_W = 6.2; // mean advance of the 11px UI face
  const MIN_GAP = 8;
  const drawn: { left: number; right: number }[] = [];

  return (
    <g aria-hidden="true">
      {labels.map((label, i) => {
        if (i % every !== 0) return null;
        const x = box.x0 + i * step;
        const anchor = i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle';
        const w = label.length * CHAR_W;
        const left = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
        const right = left + w;
        if (drawn.some((d) => left < d.right + MIN_GAP && right > d.left - MIN_GAP)) return null;
        drawn.push({ left, right });
        return (
          <text
            key={`${label}-${i}`}
            x={x}
            y={box.y1 + 14}
            textAnchor={anchor}
            fontSize={11}
            fill="var(--text-tertiary)"
          >
            {label}
          </text>
        );
      })}
    </g>
  );
}

/**
 * Direct label — the replacement for a legend.
 *
 * A legend makes the reader hold a colour in working memory and carry it
 * across the chart. Putting the name at the end of the series it names removes
 * that job entirely, which is why the design system makes it mandatory and the
 * ramp alone insufficient.
 */
export function DirectLabel({
  x,
  y,
  children,
  color = 'var(--text-secondary)',
  anchor = 'start',
}: {
  x: number;
  y: number;
  children: React.ReactNode;
  color?: string;
  anchor?: 'start' | 'middle' | 'end';
}) {
  return (
    <text x={x} y={y} textAnchor={anchor} fontSize={11} fill={color} dominantBaseline="middle">
      {children}
    </text>
  );
}

/** Caption under a chart. The finding in words, in the margin-note voice. */
export function ChartCaption({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-serif mt-1 text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
      {children}
    </p>
  );
}
