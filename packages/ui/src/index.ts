export { cn } from './lib/cn.js';
export { useMinWidth, useIsPhone, useIsTouch, BREAKPOINTS } from './lib/useBreakpoint.js';
export type { Breakpoint } from './lib/useBreakpoint.js';
export { Rail } from './composites/Rail.js';
export type { RailProps } from './composites/Rail.js';
export { StatusStamp } from './composites/StatusStamp.js';
export type { StatusStampProps } from './composites/StatusStamp.js';
export { Provisional, ConfidenceMeter, SuggestionStrip } from './composites/Provisional.js';
export { KpiTile, AsOfStamp } from './composites/KpiTile.js';
export { DataTable, Dash } from './composites/DataTable.js';
export type { Column, DataTableProps } from './composites/DataTable.js';
export { PageHeader, EmptyState, Button, Chip, TileRow, Section } from './composites/Chrome.js';
export { MoneyCell, QuantityCell, IdCell, Stacked } from './composites/Cells.js';
export { SideSheet, Detail, DetailGrid, SheetSection, Note } from './composites/SideSheet.js';
export type { SideSheetProps, SheetWidth } from './composites/SideSheet.js';
export { Modal, ConfirmModal } from './composites/Modal.js';
export type { ModalProps } from './composites/Modal.js';

/* Charts — hand-built SVG so they inherit the CSS token variables directly and
   a theme switch costs nothing. See charts/core.tsx for why this is not a
   charting library. */
export { ChartFrame, ChartCaption, GridLines, ReferenceLine, AxisLabels, DirectLabel, linearScale, niceDomain, ticks } from './charts/core.js';
export type { PlotBox, Scale } from './charts/core.js';
export { TrendChart, Sparkline, ProportionBar } from './charts/Trend.js';
export type { TrendPoint, TrendChartProps } from './charts/Trend.js';
export { BarChart, WaterfallChart, AgeingBar } from './charts/Bars.js';
export type { BarDatum, WaterfallStep } from './charts/Bars.js';
export { YieldFlow } from './charts/Flow.js';
export type { FlowOutput } from './charts/Flow.js';
export { HeatGrid, ScatterPlot, TargetGauge } from './charts/Grid.js';
export type { HeatCell, ScatterPoint } from './charts/Grid.js';
