/**
 * The Pulpitry mark, drawn without its plate so it sits on the app chrome.
 * The plated version used for the app icon lives in assets/pulpitry-mark.svg,
 * which is what scripts/build-icons.mjs rasterises.
 */
export function Logo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="150 88 282 298" className={className} role="img" aria-label="Pulpitry">
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M176 150v210h56" stroke="currentColor" strokeWidth="40" />
        <path d="M176 150h70a60 60 0 0 1 0 120h-70" stroke="currentColor" strokeWidth="40" />
        <path d="M344 134a124 124 0 0 1 0 152" stroke="currentColor" strokeWidth="26" />
        <path
          d="M378 107a168 168 0 0 1 0 206"
          stroke="currentColor"
          strokeWidth="26"
          opacity="0.5"
        />
      </g>
      <circle cx="240" cy="210" r="14" fill="currentColor" />
    </svg>
  );
}
