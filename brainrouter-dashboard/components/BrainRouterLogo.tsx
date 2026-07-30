"use client";

import type { CSSProperties } from "react";

import {
  ROUTED_B_ACCENT,
  ROUTED_B_PATHS,
  ROUTED_B_VIEWBOX,
} from "../../packages/brand/routedB";

export interface BrainRouterLogoProps {
  /** Mark height in CSS pixels. The coded geometry is legible from 16px. */
  size?: number;
  showWordmark?: boolean;
  wordmark?: string;
  /** Use one flat violet route. Set false for a one-color mark. */
  accented?: boolean;
  accentColor?: string;
  /** Kept for call-site compatibility; the Routed B is intentionally static. */
  animated?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** Accessible inline-vector BrainRouter mark and optional wordmark. */
export function BrainRouterLogo({
  size = 28,
  showWordmark = true,
  wordmark = "BrainRouter",
  accented = true,
  accentColor = ROUTED_B_ACCENT,
  className,
  style,
}: BrainRouterLogoProps) {
  return (
    <span
      className={className}
      role={showWordmark ? undefined : "img"}
      aria-label={showWordmark ? undefined : wordmark}
      style={{ display: "inline-flex", alignItems: "center", gap: `${Math.round(size * 0.38)}px`, ...style }}
    >
      <svg
        data-brand-mark="routed-b"
        width={size}
        height={size}
        viewBox={ROUTED_B_VIEWBOX}
        aria-hidden="true"
        focusable="false"
        style={{ display: "block", flexShrink: 0 }}
      >
        <path d={ROUTED_B_PATHS.upper} fill="currentColor" />
        <path d={ROUTED_B_PATHS.lower} fill={accented ? accentColor : "currentColor"} />
      </svg>

      {showWordmark ? (
        <span
          style={{
            color: "currentColor",
            fontFamily: "var(--font-sans)",
            fontSize: `${Math.round(size * 0.76)}px`,
            fontWeight: 600,
            letterSpacing: "-0.025em",
            lineHeight: 1,
            whiteSpace: "nowrap",
          }}
        >
          {wordmark}
        </span>
      ) : null}
    </span>
  );
}
