"use client";

import type { CSSProperties } from "react";

/**
 * BrainRouterLogo — the BrainRouter brand mark, generated entirely in code.
 *
 * A real 3D object built with CSS `transform-style: preserve-3d`: a translucent
 * Signal cube with the brand "node" dot on each face, slowly rotating. No
 * images and no 3D library — just transforms — so it stays crisp at any size
 * and is reusable as a building block for richer brand / loading / empty-state
 * visuals later (hence its own file + a small prop API).
 *
 * Honors prefers-reduced-motion (rotation pauses to a fixed isometric angle).
 * Purely decorative — pair it with a text wordmark for the accessible name.
 */
export function BrainRouterLogo({
  size = 28,
  spin = true,
  durationSec = 9,
  className,
  style,
}: {
  /** Edge length of the cube, in px. */
  size?: number;
  /** Auto-rotate (still honors reduced-motion). */
  spin?: boolean;
  /** Seconds per full rotation. */
  durationSec?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const sceneStyle = {
    "--brl-size": `${size}px`,
    "--brl-dur": `${durationSec}s`,
    ...style,
  } as CSSProperties;

  return (
    <span className={`brl-scene${className ? ` ${className}` : ""}`} style={sceneStyle} aria-hidden="true">
      <span className={`brl-cube${spin ? "" : " brl-static"}`}>
        <span className="brl-face brl-front" />
        <span className="brl-face brl-back" />
        <span className="brl-face brl-right" />
        <span className="brl-face brl-left" />
        <span className="brl-face brl-top" />
        <span className="brl-face brl-bottom" />
      </span>
    </span>
  );
}
