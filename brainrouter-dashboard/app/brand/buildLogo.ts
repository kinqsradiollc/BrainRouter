/**
 * buildLogoSVG — standalone logo export: the mark alone (logos without text),
 * the wordmark alone, or the full lockup — on a transparent or themed canvas.
 * Pure (no React).
 */

import { THEMES, dimsFor, resolveAccent, type BrandConfig } from "./brandPresets";
import { lockupMarkup } from "./brandShared";

export function buildLogoSVG(cfg: BrandConfig): string {
  const { w, h } = dimsFor(cfg);
  const t = THEMES[cfg.theme];
  const accent = resolveAccent(cfg);
  const bg = cfg.logoTransparent ? "" : `<rect width="${w}" height="${h}" fill="${t.bg}"/>`;
  const lh = cfg.lockup === "mark" ? Math.round(h * 0.74) : Math.round(h * 0.5);
  const lk = lockupMarkup({ x: 0, y: 0, h: lh, accent, textColor: t.text, lockup: cfg.lockup });
  const gx = (w - lk.width) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg}<g transform="translate(${gx.toFixed(1)} ${h / 2})">${lk.svg}</g></svg>`;
}
