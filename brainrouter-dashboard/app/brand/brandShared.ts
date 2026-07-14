/**
 * Shared SVG helpers for the Brand Studio builders: text escaping, robust
 * auto-fit text layout (shrink-to-fit + hard word-break + ellipsis so copy can
 * never run off the canvas), and the logo lockup composer (mark / wordmark /
 * full). Pure — no React.
 */

import { ROUTED_B_ACCENT, routedBMarkup } from "../../../packages/brand/routedB";
import type { LockupKey } from "./brandPresets";

export const FONT = "Geist, -apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', sans-serif";
export const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Wrap into lines ≤ maxChars, hard-breaking words longer than maxChars. */
export function wrapHard(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > maxChars) {
      if (cur) { out.push(cur); cur = ""; }
      out.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (cur && (cur + " " + word).length > maxChars) { out.push(cur); cur = word; }
    else cur = cur ? cur + " " + word : word;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Largest font (≤ maxFont, ≥ minFont) at which `text` wraps within boxW and the
 * wrapped block fits boxH. At minFont, caps line count to boxH and ellipsizes —
 * so text is guaranteed to fit the box.
 */
export function layoutText(
  text: string,
  boxW: number,
  boxH: number,
  maxFont: number,
  minFont: number,
  lineHeightFactor: number,
): { font: number; lines: string[] } {
  const charW = 0.55; // ~em width for Geist at weight 600
  for (let f = maxFont; f >= minFont; f -= 1) {
    const maxChars = Math.max(3, Math.floor(boxW / (f * charW)));
    const lines = wrapHard(text, maxChars);
    if (lines.length * f * lineHeightFactor <= boxH) return { font: f, lines };
  }
  const maxChars = Math.max(3, Math.floor(boxW / (minFont * charW)));
  let lines = wrapHard(text, maxChars);
  const maxLines = Math.max(1, Math.floor(boxH / (minFont * lineHeightFactor)));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    const last = lines[maxLines - 1].replace(/[\s\S]{1}$/, "");
    lines[maxLines - 1] = last + "…";
  }
  return { font: minFont, lines };
}

export function tspans(lines: string[], x: number, lineH: number): string {
  return lines.map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lineH}">${esc(l)}</tspan>`).join("");
}

/**
 * Logo lockup composed at height `h`, left edge at `x`, vertically centred on
 * `y`. Returns markup + the rendered width (for centering/measuring).
 */
/**
 * Rendered width of the logo lockup at height `h` — the single source of truth
 * shared by `lockupMarkup` (centering) and the editor's selection box, so the
 * box hugs the actual logo in every mode. The coded Routed B is square
 * (width = h); every export consumes the same canonical paths as product UI.
 * "BrainRouter" in Geist 600 (-0.02em tracking) measures ≈ 4.85× the font size
 * (fontSize = round(h·0.66)), not the looser 6.6× the old estimate used.
 */
export function lockupWidth(h: number, lockup: LockupKey): number {
  if (lockup === "mark") return Math.round(h);
  const fs = Math.round(h * 0.66);
  const textW = fs * 4.85;
  if (lockup === "wordmark") return Math.round(textW);
  return Math.round(h + h * 0.3 + textW); // mark + gap + wordmark
}

export function lockupMarkup(opts: {
  x: number;
  y: number;
  h: number;
  accent: string;
  textColor: string;
  lockup: LockupKey;
}): { svg: string; width: number } {
  const { x, y, h, textColor, lockup } = opts;
  const gap = h * 0.3;
  let svg = "";
  let cursor = x;
  if (lockup !== "wordmark") {
    svg += routedBMarkup({ x, y: y - h / 2, size: h, color: textColor, accent: ROUTED_B_ACCENT });
    cursor = x + h + gap;
  }
  if (lockup !== "mark") {
    const fs = Math.round(h * 0.66);
    svg += `<text x="${cursor.toFixed(1)}" y="${y}" font-family="${FONT}" font-size="${fs}" font-weight="600" letter-spacing="-0.02em" fill="${textColor}" dominant-baseline="central">BrainRouter</text>`;
  }
  return { svg, width: lockupWidth(h, lockup) };
}
