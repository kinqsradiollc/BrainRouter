"use client";

/**
 * BorderBeam — a Signal light that travels around a card's border. Drop inside a
 * `position: relative` container; the styling/animation lives in globals.css
 * (`.border-beam`, a masked rotating conic-gradient via @property --beam-angle).
 * Degrades gracefully to a faint static arc where @property is unsupported.
 */
export function BorderBeam({ duration = 7, delay = 0 }: { duration?: number; delay?: number }) {
  return (
    <span
      aria-hidden
      className="border-beam"
      style={{ animationDuration: `${duration}s`, animationDelay: `${delay}s` }}
    />
  );
}
