"use client";

import type { CSSProperties } from "react";

/**
 * BrainRouterLogo — the BrainRouter brand mark + wordmark, generated entirely
 * in code. The mark is a real 3D object: a solid, depth-shaded Signal cube
 * built with CSS `transform-style: preserve-3d` (no images, no 3D library),
 * slowly rotating. The "BrainRouter" wordmark is part of the lockup.
 *
 * Geometry is inline-styled (size-driven) so it renders regardless of CSS
 * custom-property support; only the spin keyframes + reduced-motion stop live
 * in globals.css (.brl-cube / @keyframes brl-spin).
 *
 * Reusable as a building block for future brand / loading / empty-state
 * visuals — pass showWordmark={false} for the mark alone, spin={false} to
 * freeze it. Honors prefers-reduced-motion.
 */

const SIGNAL = "52, 194, 142"; // Signal accent RGB

// Per-face depth shading, fixed to the faces so the tumbling cube reads as a
// lit, solid object rather than a flat wireframe.
const FACES: { key: string; alpha: number; rot: string }[] = [
  { key: "top", alpha: 0.97, rot: "rotateX(90deg)" },
  { key: "front", alpha: 0.82, rot: "" },
  { key: "right", alpha: 0.66, rot: "rotateY(90deg)" },
  { key: "left", alpha: 0.54, rot: "rotateY(-90deg)" },
  { key: "back", alpha: 0.46, rot: "rotateY(180deg)" },
  { key: "bottom", alpha: 0.36, rot: "rotateX(-90deg)" },
];

export function BrainRouterLogo({
  size = 28,
  spin = true,
  durationSec = 9,
  showWordmark = true,
  wordmark = "BrainRouter",
  className,
  style,
}: {
  /** Edge length of the cube, in px. */
  size?: number;
  /** Auto-rotate (still honors reduced-motion). */
  spin?: boolean;
  /** Seconds per full rotation. */
  durationSec?: number;
  /** Render the "BrainRouter" wordmark beside the mark. */
  showWordmark?: boolean;
  /** Override the wordmark text. */
  wordmark?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const half = size / 2;

  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: `${Math.round(size * 0.42)}px`, ...style }}
    >
      <span
        aria-hidden="true"
        style={{ display: "inline-block", width: size, height: size, perspective: size * 3.4, flexShrink: 0 }}
      >
        <span
          className="brl-cube"
          style={{
            position: "relative",
            display: "block",
            width: "100%",
            height: "100%",
            transformStyle: "preserve-3d",
            transform: "rotateX(-26deg) rotateY(-34deg)",
            animation: spin ? `brl-spin ${durationSec}s linear infinite` : "none",
          }}
        >
          {FACES.map((f) => (
            <span
              key={f.key}
              style={{
                position: "absolute",
                inset: 0,
                background: `rgba(${SIGNAL}, ${f.alpha})`,
                border: "1px solid rgba(8, 10, 12, 0.4)",
                borderRadius: Math.max(2, Math.round(size * 0.1)),
                transform: `${f.rot} translateZ(${half}px)`,
                backfaceVisibility: "hidden",
              }}
            />
          ))}
        </span>
      </span>

      {showWordmark && (
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontWeight: 600,
            fontSize: `${Math.round(size * 0.76)}px`,
            letterSpacing: "-0.01em",
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
