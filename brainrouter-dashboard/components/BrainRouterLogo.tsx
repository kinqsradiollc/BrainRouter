"use client";

import { useId } from "react";
import type { CSSProperties } from "react";

/**
 * BrainRouterLogo — the BrainRouter brand mark + wordmark, generated in code.
 *
 * The mark distills the product motif (see home/HeroGraph): a small *memory
 * graph* — a Signal "recall" core node linked to heat-coloured satellite
 * memories (the Recall-Heat ramp). Crisp vector (SVG), scalable to any size,
 * with a subtle "breathing" pulse on the core (the live-recall signal) that
 * honours prefers-reduced-motion.
 *
 * Reusable: pass showWordmark={false} for the mark alone (favicons, loaders,
 * empty states), animated={false} to freeze the pulse.
 */

// Brand palette — Signal accent + the Recall-Heat ramp (kept literal so the
// mark is self-contained, matching HeroGraph).
const SIGNAL = "#34C28E";
const HOT = "#E0A063";
const WARM = "#C98F6E";
const COOL = "#6B7480";

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
  const coreGrad = `${uid}-core`;

  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: `${Math.round(size * 0.42)}px`, ...style }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        fill="none"
        aria-hidden="true"
        style={{ display: "block", flexShrink: 0, overflow: "visible" }}
      >
        <defs>
          <linearGradient id={coreGrad} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#5FD3A8" />
            <stop offset="1" stopColor={SIGNAL} />
          </linearGradient>
        </defs>

        {/* edges — core routes out to each memory; opacity encodes strength */}
        <g stroke={SIGNAL} strokeLinecap="round">
          <line x1="20" y1="20" x2="8.5" y2="10.5" strokeWidth="1.6" strokeOpacity="0.5" />
          <line x1="20" y1="20" x2="31.5" y2="11" strokeWidth="1.3" strokeOpacity="0.36" />
          <line x1="20" y1="20" x2="30" y2="30.5" strokeWidth="1.6" strokeOpacity="0.5" />
          <line x1="20" y1="20" x2="9.5" y2="30" strokeWidth="1.3" strokeOpacity="0.34" />
        </g>
        <line x1="8.5" y1="10.5" x2="9.5" y2="30" stroke="#FFFFFF" strokeWidth="1" strokeOpacity="0.1" strokeLinecap="round" />

        {/* satellite memories (Recall-Heat ramp) */}
        <circle cx="8.5" cy="10.5" r="3.6" fill={HOT} />
        <circle cx="31.5" cy="11" r="2.9" fill={SIGNAL} fillOpacity="0.7" />
        <circle cx="30" cy="30.5" r="3.2" fill={WARM} />
        <circle cx="9.5" cy="30" r="2.5" fill={COOL} />

        {/* breathing recall signal on the core */}
        {animated && <circle className="brl-pulse" cx="20" cy="20" r="6.6" fill={SIGNAL} />}

        {/* core "recall" node */}
        <circle cx="20" cy="20" r="6.6" fill={`url(#${coreGrad})`} />
        <circle cx="20" cy="20" r="6.6" fill="none" stroke="#FFFFFF" strokeOpacity="0.18" strokeWidth="1" />
        {/* top highlight for dimension */}
        <circle cx="20" cy="17.6" r="2.9" fill="#FFFFFF" fillOpacity="0.16" />
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
