/**
 * Our own mark: a sea-buckthorn sprig (cătină) — two berries and a leaf.
 * Deliberately not modelled on any competitor's logo; the visual system is
 * shared, the identity is not.
 */
export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      fill="none"
      className={className}
      aria-hidden
      focusable="false"
    >
      <rect width="28" height="28" rx="8" fill="var(--accent)" />
      <path
        d="M14 7.5c-3.1 0-5.2 2.1-5.2 4.9 0 3.3 3.1 6.1 5.2 8.1 2.1-2 5.2-4.8 5.2-8.1 0-2.8-2.1-4.9-5.2-4.9Z"
        fill="#fff"
        fillOpacity="0.25"
      />
      <circle cx="11.2" cy="12.6" r="2.6" fill="#fff" />
      <circle cx="16.8" cy="15.4" r="2.6" fill="#fff" fillOpacity="0.82" />
      <path
        d="M14 6.2c1.9.5 3 1.9 3.2 3.9-1.9-.4-3-1.7-3.2-3.9Z"
        fill="#fff"
        fillOpacity="0.6"
      />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="text-[17px] font-semibold tracking-[-0.02em] text-foreground">
      Cătină
    </span>
  );
}
