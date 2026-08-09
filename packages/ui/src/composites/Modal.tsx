import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './Chrome.js';

/**
 * MODAL — reserved for decisions, never for detail.
 *
 * Detail belongs in a side sheet, which leaves the list visible behind it. A
 * modal takes the whole screen hostage, so it is used only where the next click
 * genuinely must not happen by accident: reversing a posting, cancelling an
 * e-way bill inside its 24-hour window, rejecting a breakdown indent while a
 * crusher is stopped.
 *
 * It earns `--e2` under the dismissibility rule, because Escape closes it.
 */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}

export function Modal({ open, onClose, title, children, footer, width = 460 }: ModalProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return undefined;
    document.addEventListener('keydown', onKeyDown);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onKeyDown]);

  if (!open) return null;

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-[60]"
        style={{ background: 'var(--surface-overlay)' }}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="fixed left-1/2 top-1/2 z-[61] flex max-h-[80vh] flex-col outline-none"
        style={{
          width: `min(${width}px, calc(100vw - 32px))`,
          transform: 'translate(-50%, -50%)',
          background: 'var(--surface-raised)',
          borderRadius: 'var(--r-2)',
          boxShadow: 'var(--e2)',
          animation: 'linck-fade var(--dur-layer) var(--ease)',
        }}
      >
        <header className="px-5 pb-2 pt-4">
          <h2 className="font-serif text-[18px]" style={{ color: 'var(--text-primary)' }}>
            {title}
          </h2>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          {children}
        </div>
        {/*
          The footer reverses on a phone: buttons stack, and `flex-col-reverse`
          puts the primary action at the BOTTOM of the stack — nearest the
          thumb, and last in the reading order, so "Cancel" is never the thing
          under a thumb reaching for "Confirm".
        */}
        {footer ? (
          <footer
            className="flex flex-col-reverse gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-end [&>button]:w-full sm:[&>button]:w-auto"
            style={{ borderTop: '1px solid var(--border-subtle)' }}
          >
            {footer}
          </footer>
        ) : null}
      </div>
    </>
  );
}

/**
 * Confirmation for something that cannot be taken back.
 *
 * `confirmPhrase` demands the operator type an exact string. That is reserved
 * for actions that reverse a posting or destroy a statutory document — the
 * friction is the point, and using it on ordinary actions trains people to type
 * past it without reading.
 *
 * The consequence is stated in plain language, with the real numbers in it. "Are
 * you sure?" tells an operator nothing they did not already know.
 */
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  consequence,
  confirmLabel = 'Confirm',
  confirmPhrase,
  destructive,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  consequence: React.ReactNode;
  confirmLabel?: string;
  confirmPhrase?: string;
  destructive?: boolean;
}) {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const armed = !confirmPhrase || typed.trim() === confirmPhrase;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            disabled={!armed}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="font-serif text-[14px] italic" style={{ color: 'var(--text-primary)' }}>
        {consequence}
      </div>
      {confirmPhrase ? (
        <label className="mt-4 block">
          <span className="block text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            Type <span className="font-id" style={{ color: 'var(--text-primary)' }}>{confirmPhrase}</span> to confirm
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="font-id mt-1 h-[34px] w-full px-2 text-[13px]"
            style={{
              background: 'var(--surface)',
              color: 'var(--text-primary)',
              borderRadius: 'var(--r-1)',
              boxShadow: 'inset 0 0 0 1px var(--border-strong)',
            }}
          />
        </label>
      ) : null}
    </Modal>
  );
}
