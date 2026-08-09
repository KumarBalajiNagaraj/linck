import { cn } from '../lib/cn.js';

/**
 * DASHED-AND-HATCHED MEANS NOT-YET-TRUE — signature move #2.
 *
 * One achromatic 45° texture plus a dashed rule marks EVERY value in the
 * system that is asserted but not confirmed: an OCR'd litre count, a payment
 * reported but unmatched, an estimated toll, a provisional margin, a manually
 * keyed weighbridge net, a backdated stock movement.
 *
 * Confirming it dissolves the hatch and solidifies the rule. The ink dries.
 * That is the entire AI celebration.
 *
 * The owner's rule — an invoice does not close until payment is cross-verified
 * — stops being policy documentation and becomes the border style of the
 * application. A receivables screen full of hatch is a screen full of money
 * that is not really yours yet, visible from across the room.
 *
 * NOTE the one thing this component deliberately does NOT do: dim the value.
 * An operator's whole job here is reading that number against a photograph of
 * a paper bill, and reducing its legibility to signal provenance produces
 * wrong data. AI values stay full-contrast.
 */

export interface ProvisionalProps {
  children: React.ReactNode;
  /** Once confirmed, the hatch dissolves and the rule goes solid. */
  confirmed?: boolean | undefined;
  /** A human replaced the machine's value — keeps a diagonal strike on the mark. */
  overridden?: boolean | undefined;
  /** The machine's original reading, revealed on hover after an override. */
  originalValue?: string | undefined;
  className?: string | undefined;
}

export function Provisional({ children, confirmed, overridden, originalValue, className }: ProvisionalProps) {
  return (
    <span
      className={cn('relative inline-flex items-center gap-1.5 px-1 transition-[background,border-color]', className)}
      style={{
        backgroundImage: confirmed ? 'none' : 'var(--hatch-pattern)',
        borderBottom: `1px ${confirmed ? 'solid' : 'dashed'} ${confirmed ? 'var(--border-strong)' : 'var(--provisional-rule)'}`,
        transitionDuration: 'var(--dur-confirm)',
        transitionTimingFunction: 'var(--ease)',
      }}
      title={
        overridden && originalValue
          ? `Linck read ${originalValue} — corrected by hand`
          : confirmed
            ? 'Read by Linck, confirmed by a person'
            : 'Read by Linck — not yet confirmed'
      }
    >
      {children}
      <ExtractionMark overridden={overridden} hidden={confirmed && !overridden} />
    </span>
  );
}

/**
 * The extraction mark: a small square with a diagonal cut.
 * Explicitly NOT a sparkle — sparkles, wands, gradients, glowing borders,
 * typewriter animation and the word "magic" are banned as AI signifiers.
 */
function ExtractionMark({ overridden, hidden }: { overridden?: boolean | undefined; hidden?: boolean | undefined }) {
  if (hidden) return null;
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="shrink-0">
      <path d="M0.5 0.5 H9.5 V9.5 H0.5 Z" fill="none" stroke="var(--provisional-rule)" strokeWidth="1" />
      <path d="M9.5 0.5 L0.5 9.5" stroke="var(--provisional-rule)" strokeWidth="1" />
      {overridden ? <path d="M0.5 0.5 L9.5 9.5" stroke="var(--text-primary)" strokeWidth="1.2" /> : null}
    </svg>
  );
}

/**
 * Confidence is a SHAPE, not a colour.
 *
 * Three discrete segments, achromatic. Never a percentage, never a gradient:
 * a gradient across fourteen extracted fields is unreadable, and a
 * 62%-confident CORRECT reading must not look like a problem.
 *
 * Below the configured floor the meter shows a notch and the field
 * auto-focuses first — tab order follows uncertainty, not layout.
 */
export function ConfidenceMeter({ level, className }: { level: 1 | 2 | 3; className?: string | undefined }) {
  return (
    <span
      className={cn('inline-flex items-center gap-[2px]', className)}
      title={`Extraction confidence ${level} of 3`}
      aria-label={`Extraction confidence ${level} of 3`}
    >
      {([1, 2, 3] as const).map((seg) => (
        <span
          key={seg}
          className="block h-[3px] w-[6px]"
          style={{
            background: seg <= level ? 'var(--confidence-fill)' : 'transparent',
            boxShadow: seg <= level ? 'none' : 'inset 0 0 0 1px var(--border-strong)',
          }}
        />
      ))}
      {level === 1 ? (
        <span aria-hidden="true" className="ml-0.5 text-[9px]" style={{ color: 'var(--status-attention)' }}>
          ▲
        </span>
      ) : null}
    </span>
  );
}

/**
 * AI-suggested ACTIONS are a different object from AI-suggested DATA.
 *
 * A strip pinned above the relevant table — never inline in a row, never
 * auto-applied, and dismissal is recorded (it is the signal that the rule is
 * wrong, and it is training data).
 */
export interface SuggestionStripProps {
  children: React.ReactNode;
  onApply?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
  applyLabel?: string | undefined;
}

export function SuggestionStrip({ children, onApply, onDismiss, applyLabel = 'Apply' }: SuggestionStripProps) {
  return (
    // Wraps on a phone, where the sentence and two actions cannot share a row:
    // at 375px the buttons held their width and compressed the sentence — which
    // is the part that says what applying would do — to about 185px.
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]"
      style={{
        background: 'var(--surface-sunken)',
        border: '1px dashed var(--provisional-rule)',
        borderRadius: 'var(--r-1)',
        color: 'var(--text-secondary)',
      }}
    >
      <span className="min-w-[12rem] flex-1">{children}</span>
      {onApply ? (
        <button
          type="button"
          onClick={onApply}
          className="h-11 px-2 text-[12px] font-medium [@media(hover:hover)]:h-6"
          style={{ color: 'var(--brand)', borderRadius: 'var(--r-1)' }}
        >
          {applyLabel}
        </button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="h-11 px-2 text-[12px] [@media(hover:hover)]:h-6"
          style={{ color: 'var(--text-tertiary)', borderRadius: 'var(--r-1)' }}
        >
          Dismiss
        </button>
      ) : null}
    </div>
  );
}
