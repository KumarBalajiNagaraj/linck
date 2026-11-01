/** Linck's mark: the top bar's, and the sign-in screen's. */
export function Mark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="1.5" y="1.5" width="17" height="17" rx="2" fill="none" stroke="var(--brand)" strokeWidth="1.5" />
      <path d="M6 14 V6 M6 14 H14" stroke="var(--brand)" strokeWidth="1.75" fill="none" />
    </svg>
  );
}
