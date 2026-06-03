/**
 * Keep each layer's box (w/h) matching what actually renders, so selection
 * boxes / handles / the inline editor hug the content:
 *  - text  → AUTO-WIDTH: box = widest line × line count (wraps only on explicit
 *            newlines), so the box never extends past the words
 *  - logo  → width follows the rendered lockup (mark + wordmark)
 * Shapes/images already fill their box. Pure.
 */

import type { Layer, TextLayer, LogoLayer, BadgeLayer } from "./types";

export function measuredTextBox(l: TextLayer): { w: number; h: number } {
  const lines = (l.text && l.text.length ? l.text : " ").split("\n");
  const cw = l.fontSize * 0.56;
  let w = 0;
  for (const ln of lines) {
    const lw = ln.length * cw + Math.max(0, ln.length - 1) * l.letterSpacing;
    if (lw > w) w = lw;
  }
  return {
    w: Math.max(Math.round(l.fontSize * 0.6), Math.round(w)),
    h: Math.max(Math.round(l.fontSize * l.lineHeight), Math.round(lines.length * l.fontSize * l.lineHeight)),
  };
}

export function logoWidth(l: LogoLayer): number {
  const fs = l.h * 0.66;
  const gap = l.h * 0.3;
  const wm = fs * 0.6 * 11; // ≈ "BrainRouter"
  if (l.lockup === "mark") return Math.round(l.h);
  if (l.lockup === "wordmark") return Math.round(wm);
  return Math.round(l.h + gap + wm);
}

/** Badge pill width — mirrors roleBadgeMarkup's own width estimate so the box
 *  hugs the rendered pill. Font size is derived from the box height (h = fs·2.15). */
export function badgeWidth(l: BadgeLayer): number {
  const fs = l.h / 2.15;
  const label = l.label && l.label.length ? l.label : " ";
  const textW = label.length * fs * 0.66 + Math.max(0, label.length - 1) * fs * 0.08;
  return Math.round(fs * 0.95 * 2 + fs * 1.1 + fs * 0.5 + textW);
}

export function normalizeLayer(l: Layer): Layer {
  if (l.type === "text") {
    const { w, h } = measuredTextBox(l);
    // Auto-width shrinks the box to the content; keep the *visual* anchor so a
    // centre/right-aligned line stays put instead of drifting left as it shrinks.
    let x = l.x;
    if (l.align === "center") x = Math.round(l.x + l.w / 2 - w / 2);
    else if (l.align === "right") x = Math.round(l.x + l.w - w);
    return { ...l, x, w, h };
  }
  if (l.type === "logo") return { ...l, w: logoWidth(l) };
  if (l.type === "badge") return { ...l, w: badgeWidth(l) };
  return l;
}
