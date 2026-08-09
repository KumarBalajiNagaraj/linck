/**
 * The seven status families.
 *
 * LAW 2: status is never carried by hue. Every state ships four redundant
 * channels — glyph, word, rail pattern, fill weight — and hue is the fourth.
 * Strip all colour and every state must remain distinguishable: roughly 1 in
 * 12 Indian men has a red-green deficiency and the fleet supervisor is not
 * exempt.
 *
 * This is the single source of truth. The stamp, the row rail, the filter
 * chip and the CSV export all read from here so `under_service` cannot render
 * as "Maintenance" in one place and "In workshop" in another.
 */
export type StatusFamily =
  | 'ready'
  | 'active'
  | 'attention'
  | 'planned'
  | 'critical'
  | 'pending'
  | 'dormant';

/** Rail pattern — the colourless channel. Readable in pure greyscale. */
export type RailPattern = 'solid' | 'solid-heavy' | 'dotted' | 'hatched' | 'hollow';

export interface StatusSpec {
  family: StatusFamily;
  /** Leading glyph. Inline SVG in the component; never emoji. */
  glyph: string;
  railPattern: RailPattern;
  /** `none` means the stamp is a hairline outline only — pending consumes zero colour budget. */
  fill: 'tint' | 'none' | 'unbleached';
  /** CSS custom property holding the family's ink colour. */
  colorVar: string;
  tintVar: string | null;
  /** What this family means, in the words an operator would use. */
  meaning: string;
}

export const STATUS: Record<StatusFamily, StatusSpec> = {
  ready: {
    family: 'ready',
    glyph: '●',
    railPattern: 'solid',
    fill: 'tint',
    colorVar: '--status-ready',
    tintVar: '--status-ready-tint',
    meaning: 'Settled and good. Vehicle ready for trips, stock OK, document valid, payment verified.',
  },
  active: {
    family: 'active',
    glyph: '▶',
    railPattern: 'solid',
    fill: 'tint',
    colorVar: '--status-active',
    tintVar: '--status-active-tint',
    meaning: 'In motion and healthy. On trip, invoice issued, job card in progress, loading.',
  },
  attention: {
    family: 'attention',
    glyph: '◐',
    railPattern: 'dotted',
    fill: 'tint',
    colorVar: '--status-attention',
    tintVar: '--status-attention-tint',
    meaning:
      'A human should act soon. Vehicle idle but unassigned (the productivity leak), stock low, part-paid, payment reported but NOT verified, document expiring.',
  },
  planned: {
    family: 'planned',
    glyph: '▣',
    railPattern: 'hatched',
    fill: 'tint',
    colorVar: '--status-planned',
    tintVar: '--status-planned-tint',
    meaning:
      'Deliberate and scheduled, not a problem. Under maintenance, workshop slot booked. Hatched because a vehicle in the workshop is a vehicle whose availability is not yet confirmed.',
  },
  critical: {
    family: 'critical',
    glyph: '▲',
    railPattern: 'solid-heavy',
    fill: 'tint',
    colorVar: '--status-critical',
    tintVar: '--status-critical-tint',
    meaning: 'Blocking or failed. Breakdown, overdue, stock out, document expired. Always carries an integer.',
  },
  pending: {
    family: 'pending',
    glyph: '◆',
    railPattern: 'dotted',
    fill: 'none',
    colorVar: '--status-pending',
    tintVar: null,
    meaning: "In flight and fine — the ball is in someone else's court. Normal progress spends zero colour budget.",
  },
  dormant: {
    family: 'dormant',
    glyph: '▨',
    railPattern: 'hollow',
    fill: 'unbleached',
    colorVar: '--status-dormant',
    tintVar: '--status-dormant-tint',
    meaning: 'The absence of state. Off-road, draft, retired, locked, reversed, period-closed.',
  },
};

/**
 * Provenance — the rail's other job, done colourlessly.
 *
 * Scan forty rows and you can see where every number came from without one
 * pixel of colour being spent on it. The XLSX the CA receives carries a
 * Source column with the same four words.
 */
export type Provenance =
  | 'human'       /* someone typed it */
  | 'proposed'    /* machine-read, not yet confirmed */
  | 'confirmed'   /* machine-read, human confirmed — hover names who and when */
  | 'overridden'  /* a human replaced the machine's value */
  | 'device';     /* weighbridge, telematics, VAHAN, GSTN, NIC, bank import */

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  human: 'Entered by hand',
  proposed: 'Read by Linck — not yet confirmed',
  confirmed: 'Read by Linck — confirmed',
  overridden: 'Corrected by hand',
  device: 'From a device or integration',
};
