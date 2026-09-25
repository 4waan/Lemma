/** The Lemma mark: a turnstile (⊢, "proves") in a rounded square. Colors come from the stylesheet. */
export function Logo({ size = 28 }: { size?: number | undefined }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect className="brand-mark-bg" width="28" height="28" rx="7" />
      <path className="brand-mark-fg" d="M10 7.5v13M10 14h9" fill="none" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
