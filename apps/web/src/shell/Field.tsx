import { Rail } from '@linck/ui';

/**
 * The parts of a form on a live record screen (customers, orders,
 * breakdowns), drawn as the expense forms draw theirs (UploadBillSheet): a
 * thumb-sized box on a phone, a desk-sized one under a mouse.
 */

export const FIELD_CLASS = 'h-11 w-full px-2 text-[16px] [@media(hover:hover)]:h-[38px] [@media(hover:hover)]:text-[14px]';

export const FIELD_STYLE: React.CSSProperties = {
  background: 'var(--surface)',
  color: 'var(--text-primary)',
  boxShadow: 'inset 0 0 0 1px var(--border-strong)',
  borderRadius: 'var(--r-1)',
};

/**
 * A labelled field. The box itself never turns red — the typed value has to
 * stay readable while it is fixed; a rail and a line carry the alarm. `echo`
 * reads back what a typed figure was taken as, before anyone saves it.
 */
export function Field({
  label,
  children,
  hint = null,
  error = null,
  echo = null,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string | null;
  error?: string | null;
  echo?: string | null;
}) {
  return (
    <label className="relative flex min-w-0 flex-col gap-1">
      {/* The rail sits in the gutter beside the field, never over its label. */}
      {error ? (
        <span aria-hidden="true" className="absolute -left-2 bottom-0 top-0 w-[5px]">
          <Rail status="critical" />
        </span>
      ) : null}
      <span className="flex flex-wrap items-baseline gap-x-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
        {label}
        {hint ? (
          <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
            {hint}
          </span>
        ) : null}
      </span>
      {children}
      {error ? (
        <span className="text-[13px]" style={{ color: 'var(--status-critical)' }}>
          {error}
        </span>
      ) : echo ? (
        <span className="num text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {echo}
        </span>
      ) : null}
    </label>
  );
}

/** Why the API refused, kept in view until the next try — and after the record has moved on, so the reason is not lost with it. */
export function Refusal({ text }: { text: string }) {
  return (
    <p role="alert" className="relative mb-2 pl-3 text-[14px]" style={{ color: 'var(--status-critical)' }}>
      <Rail status="critical" />
      {text}
    </p>
  );
}

/**
 * What a form still needs before it can be saved, under the form. Not in the
 * sheet's footer: the footer is one 56px row, and a list of missing fields in
 * Tamil on a phone does not fit beside the buttons.
 */
export function StillNeeded({ text }: { text: string }) {
  return (
    <p className="mt-3 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
      {text}
    </p>
  );
}

/** "Saving…", while a request is on its way. */
export function Busy({ text }: { text: string }) {
  return (
    <p className="mt-2 text-[14px]" aria-live="polite" style={{ color: 'var(--text-secondary)' }}>
      {text}
    </p>
  );
}
