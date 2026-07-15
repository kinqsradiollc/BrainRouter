"use client";

/** Full-page centered loader (auth bootstrap, route-level suspense). */
export function LoadingSpinner() {
  return (
    <div className="loading-spinner-shell">
      <div className="loading-spinner-ring" />
    </div>
  );
}

/**
 * Inline loader — a small animated ring + label. Replaces bare "Loading…" text
 * in panels/lists so a load reads as active, not stalled. Same style budget as
 * `settings-empty-inline` (13px muted) + the shared `brainrouter-spin` ring.
 */
export function InlineLoading({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div className={`inline-loading${className ? ` ${className}` : ""}`} role="status" aria-live="polite">
      <span className="inline-loading-ring" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
