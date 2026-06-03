"use client";

import { useId } from "react";
import type { CSSProperties } from "react";

/**
 * BrainRouterLogo — the BrainRouter brand mark + wordmark, generated in code.
 *
 * The mark is a guilloché rosette: interwoven Signal rings (a 12-fold
 * flower-of-life lattice) with six memory nodes routed around a glossy
 * "recall" core. Procedurally drawn vector — intricate and hard to replicate,
 * yet crisp at any size; the bright core keeps it legible down to ~24px.
 *
 * Reusable: showWordmark={false} for the mark alone (favicons, loaders, empty
 * states); animated={false} to freeze the subtle core pulse. Honors
 * prefers-reduced-motion.
 */

const SIGNAL = "#34C28E";
const RING = 44; // outer containing ring radius (viewBox is -50..50)

// flower-of-life lattice: two 6-circle rings, offset 30° → 12-fold interference
const PETALS = Array.from({ length: 6 }, (_, i) => (i * 60 * Math.PI) / 180);
const PETALS_OFFSET = Array.from({ length: 6 }, (_, i) => ((i * 60 + 30) * Math.PI) / 180);
const onCircle = (a: number, dist: number) => ({ x: +(Math.cos(a) * dist).toFixed(2), y: +(Math.sin(a) * dist).toFixed(2) });

export function BrainRouterLogo({
  size = 28,
  showWordmark = true,
  wordmark = "BrainRouter",
  animated = true,
  className,
  style,
}: {
  /** Mark height in px (the wordmark scales from it). */
  size?: number;
  showWordmark?: boolean;
  wordmark?: string;
  /** Subtle breathing pulse on the core node (honors reduced-motion). */
  animated?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const uid = useId().replace(/:/g, "");
  const grad = `${uid}-g`;
  const coreGrad = `${uid}-core`;

  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: `${Math.round(size * 0.42)}px`, ...style }}
    >
      <svg
        width={size}
        height={size}
        viewBox="-50 -50 100 100"
        fill="none"
        aria-hidden="true"
        style={{ display: "block", flexShrink: 0, overflow: "visible" }}
      >
        <defs>
          <linearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7FE6BE" />
            <stop offset="1" stopColor={SIGNAL} />
          </linearGradient>
          <radialGradient id={coreGrad} cx="0.38" cy="0.32" r="0.78">
            <stop offset="0" stopColor="#7FE6BE" />
            <stop offset="1" stopColor={SIGNAL} />
          </radialGradient>
        </defs>

        {/* containing ring */}
        <circle r={RING} stroke={SIGNAL} strokeWidth="1" strokeOpacity="0.32" />

        {/* primary lattice — gradient stroke */}
        {PETALS.map((a, i) => {
          const c = onCircle(a, 22);
          return <circle key={`p${i}`} cx={c.x} cy={c.y} r={22} stroke={`url(#${grad})`} strokeWidth="1" strokeOpacity="0.6" />;
        })}
        {/* offset lattice — finer, builds the 12-fold interference */}
        {PETALS_OFFSET.map((a, i) => {
          const c = onCircle(a, 22);
          return <circle key={`o${i}`} cx={c.x} cy={c.y} r={22} stroke={SIGNAL} strokeWidth="0.75" strokeOpacity="0.32" />;
        })}

        {/* memory nodes routed around the ring */}
        {PETALS.map((a, i) => {
          const c = onCircle(a, RING);
          return <circle key={`n${i}`} cx={c.x} cy={c.y} r={2.4} fill={SIGNAL} />;
        })}

        {/* breathing recall signal */}
        {animated && <circle className="brl-pulse" r={7} fill={SIGNAL} />}

        {/* core "recall" node */}
        <circle r={7} fill={`url(#${coreGrad})`} />
        <circle r={7} stroke="#fff" strokeOpacity="0.22" strokeWidth="0.8" />
        <circle cx={-2.3} cy={-2.8} r={3} fill="#fff" fillOpacity="0.2" />
      </svg>

      {showWordmark && (
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontWeight: 600,
            fontSize: `${Math.round(size * 0.76)}px`,
            letterSpacing: "-0.015em",
            color: "var(--text)",
            whiteSpace: "nowrap",
            lineHeight: 1,
          }}
        >
          {wordmark}
        </span>
      )}
    </span>
  );
}
