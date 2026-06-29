/**
 * INTERACTIVE PROTOTYPE — placeholder resolve-and-swap (§3 D2).
 *
 * The host side of the async-placeholder pattern: a generated prototype embeds
 * `br-pending-gen://<id>` tokens (see {@link ./protoDetect}) wherever the agent
 * couldn't inline an asset. Before the prototype is shown, those tokens are
 * swapped for a self-contained, animated SVG placeholder so the page renders
 * immediately with no external requests. (When an asset generator later produces
 * the real content, the same `resolvePlaceholder` swaps it in — but with media
 * generation out of scope, the animated SVG is the terminal render.)
 *
 * Pure + dependency-free → unit-tested. The desktop poll loop calls
 * `inlinePlaceholders` on the stable file before handing it to the renderer.
 */

import { findPlaceholderTokens, resolvePlaceholder } from './protoDetect.js';
import { isHexColor } from './prototypePrompt.js';

export interface PlaceholderOptions {
  /** Visible caption (defaults to the placeholder id). */
  label?: string;
  width?: number;
  height?: number;
  /** Accent hex color (#rgb / #rrggbb); invalid values fall back to the default. */
  color?: string;
}

const DEFAULT_COLOR = '#6366f1';

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A self-contained animated SVG placeholder for one pending asset — a soft
 * pulsing panel captioned with the label. No scripts, no external refs, so it
 * renders identically inline, as an `img` src, or inside a sandboxed frame.
 */
export function buildPlaceholderSvg(id: string, opts: PlaceholderOptions = {}): string {
  const w = clampInt(opts.width, 1, 8192, 480);
  const h = clampInt(opts.height, 1, 8192, 320);
  const color = opts.color && isHexColor(opts.color) ? opts.color.trim() : DEFAULT_COLOR;
  const label = escapeXml((opts.label ?? id).trim() || id);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label} (generating)">` +
    `<rect width="100%" height="100%" fill="#f1f5f9"/>` +
    `<rect width="100%" height="100%" fill="${color}" opacity="0.12">` +
    `<animate attributeName="opacity" values="0.06;0.18;0.06" dur="1.4s" repeatCount="indefinite"/>` +
    `</rect>` +
    `<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="14" fill="${color}">${label}…</text>` +
    `</svg>`;
}

/** The placeholder SVG as a `data:` URI, usable directly as an `img` src. */
export function placeholderSvgDataUri(id: string, opts: PlaceholderOptions = {}): string {
  return `data:image/svg+xml,${encodeURIComponent(buildPlaceholderSvg(id, opts))}`;
}

/**
 * Replace every `br-pending-gen://<id>` token in a document with its animated
 * SVG placeholder (as a data URI), so the prototype is fully self-contained and
 * renderable. Idempotent — a document with no tokens is returned unchanged.
 */
export function inlinePlaceholders(html: string, opts: PlaceholderOptions = {}): string {
  let out = html;
  for (const id of findPlaceholderTokens(html)) {
    out = resolvePlaceholder(out, id, placeholderSvgDataUri(id, opts));
  }
  return out;
}
