/**
 * Keep each layer's box (w/h) matching what actually renders, so selection
 * boxes / handles / the inline editor line up with the content:
 *  - text  → height follows the wrapped line count (width is the wrap frame)
 *  - logo  → width follows the rendered lockup (mark + wordmark)
 * Shapes/images already fill their box. Pure.
 */

import type { Layer, TextLayer, LogoLayer } from "./types";
import { wrapHard } from "../brandShared";

export function measuredTextHeight(l: TextLayer): number {
  const maxChars = Math.max(1, Math.floor(l.w / (l.fontSize * 0.56 + Math.max(0, l.letterSpacing))));
  const lines = wrapHard(l.text || " ", maxChars);
  return Math.max(Math.round(l.fontSize * l.lineHeight), Math.round(lines.length * l.fontSize * l.lineHeight));
}

export function logoWidth(l: LogoLayer): number {
  const fs = l.h * 0.66;
  const gap = l.h * 0.3;
  const wm = fs * 0.6 * 11; // ≈ "BrainRouter"
  if (l.lockup === "mark") return Math.round(l.h);
  if (l.lockup === "wordmark") return Math.round(wm);
  return Math.round(l.h + gap + wm);
}

export function normalizeLayer(l: Layer): Layer {
  if (l.type === "text") return { ...l, h: measuredTextHeight(l) };
  if (l.type === "logo") return { ...l, w: logoWidth(l) };
  return l;
}
