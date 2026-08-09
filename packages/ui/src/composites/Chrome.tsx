import { cn } from '../lib/cn.js';

/**
 * Page header. The italic eyebrow above the title names the module — signature
 * move #4, the thing that makes the app read as typeset rather than assembled.
 * Breadcrumbs live here, not in the topbar.
 */
export function PageHeader({
  eyebrow,
  title,
  actions,
  meta,
}: {
  eyebrow: string;
  title: string;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <header
      className="flex flex-col items-start gap-3 px-6 pb-3 pt-5 sm:flex-row sm:items-end sm:justify-between sm:gap-6"
      style={{ borderBottom: '1px solid var(--border-subtle)' }}
    >
      <div className="min-w-0">
        <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
          {eyebrow}
        </p>
        <h1 className="font-serif text-[24px] leading-tight" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h1>
        {meta ? <div className="mt-1.5">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * EMPTY STATE — no illustration, no mascot, no oversized icon, ever.
 *
 * A sentence stating the fact, an italic line giving the cause or consequence,
 * and exactly one text button. Filtered-empty and genuinely-empty are
 * different problems and never share copy.
 */
export function EmptyState({
  fact,
  because,
  action,
}: {
  fact: string;
  because?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-start gap-1.5 px-6 py-12">
      <p className="font-serif text-[18px]" style={{ color: 'var(--text-primary)' }}>
        {fact}
      </p>
      {because ? (
        <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
          {because}
        </p>
      ) : null}
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-2 text-[13px] font-medium"
          style={{ color: 'var(--brand)' }}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export function Button({
  variant = 'secondary',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'destructive' }) {
  const style: React.CSSProperties =
    variant === 'primary'
      ? { background: 'var(--brand)', color: 'var(--text-inverse)' }
      : variant === 'destructive'
        ? { background: 'transparent', color: 'var(--status-critical)' }
        : { background: 'var(--surface)', color: 'var(--text-primary)', boxShadow: 'inset 0 0 0 1px var(--border-strong)' };

  return (
    <button
      type="button"
      {...props}
      className={cn(
        // 44px on a touch device, 34px on a desk. The desktop height is a
        // deliberate density choice and the touch height is a floor below which
        // a control is genuinely hard to hit — so the rule is keyed to whether
        // the pointer can hover, not to screen width. A weighbridge terminal is
        // a wide screen that still needs the big target.
        'inline-flex h-11 items-center justify-center gap-1.5 px-3 text-[14px] font-medium',
        '[@media(hover:hover)]:h-[34px] [@media(hover:hover)]:justify-start',
        'disabled:opacity-45',
        className,
      )}
      style={{ borderRadius: 'var(--r-1)', ...style }}
    />
  );
}

/** A filter/saved-view chip. Never carries a left rail — that belongs to status alone. */
export function Chip({
  active,
  children,
  onClick,
  count,
}: {
  active?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center gap-1.5 px-3 text-[12px] [@media(hover:hover)]:h-7 [@media(hover:hover)]:px-2.5"
      style={{
        borderRadius: 'var(--r-1)',
        background: active ? 'var(--brand-tint)' : 'transparent',
        color: active ? 'var(--brand)' : 'var(--text-secondary)',
        boxShadow: `inset 0 0 0 1px ${active ? 'var(--brand)' : 'var(--border-default)'}`,
      }}
    >
      {children}
      {count !== undefined ? <span className="num tabular-nums opacity-70">{count}</span> : null}
    </button>
  );
}

/** A panel of KPI tiles, separated by hairlines rather than boxed as cards. */
export function TileRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn('grid', className)}
      style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border-subtle)' }}
    >
      {children}
    </div>
  );
}

/**
 * Section shell for a board or table, with the italic caption that titles it.
 */
export function Section({
  caption,
  title,
  actions,
  children,
}: {
  caption?: string;
  title?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-7">
      {caption || title || actions ? (
        <div className="flex flex-col items-start gap-2 px-6 pb-2 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
          <div>
            {caption ? (
              <p className="font-serif text-[13px] italic" style={{ color: 'var(--text-tertiary)' }}>
                {caption}
              </p>
            ) : null}
            {title ? (
              <h2 className="font-serif text-[18px]" style={{ color: 'var(--text-primary)' }}>
                {title}
              </h2>
            ) : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}
