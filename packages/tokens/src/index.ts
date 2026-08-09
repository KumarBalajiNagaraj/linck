export { STATUS, PROVENANCE_LABEL } from './status.js';
export type { StatusFamily, StatusSpec, RailPattern, Provenance } from './status.js';

/** Row density. Same components, same tokens, one attribute. */
export const DENSITIES = ['compact', 'default', 'comfortable', 'touch'] as const;
export type Density = (typeof DENSITIES)[number];

export const DENSITY_ROW_PX: Record<Density, number> = {
  compact: 28,
  default: 32,
  comfortable: 40,
  touch: 48,
};

/**
 * Chart ramp — monochrome by rule. A chart series can never be mistaken for a
 * status colour, so emphasis is weight or a direct label, never a second hue.
 * Direct labelling is MANDATORY; the ramp alone is not a legend.
 */
export const CHART_RAMP = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;
