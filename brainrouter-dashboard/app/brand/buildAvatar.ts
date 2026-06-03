/**
 * buildAvatarSVG — a 1024² profile-picture frame: the uploaded photo clipped to
 * a circle / rounded / square, wrapped in a branded ring (gradient, solid,
 * guilloché, dual-arc or hairline) with an optional role badge (Founder, Core
 * team, Verified, …). Transparent corners by default so it drops onto any
 * platform avatar. Pure (no React); the photo rides along as a data URL.
 */

import { THEMES, ROLES, resolveAccent, type BrandConfig } from "./brandPresets";
import { guillocheMarkup } from "./brandMark";
import { MONO } from "./brandShared";
import { roleBadgeMarkup } from "./roleBadge";

export function buildAvatarSVG(cfg: BrandConfig): string {
  const S = 1024;
  const c = S / 2;
  const t = THEMES[cfg.theme];
  const accent = resolveAccent(cfg);
  const R = 408;
  const ringW = Math.round(6 + cfg.ringWidth * 5);
  const corner = cfg.avatarShape === "rounded" ? Math.round(R * 0.34) : cfg.avatarShape === "square" ? Math.round(R * 0.06) : R;
  const isCircle = cfg.avatarShape === "circle";

  let defs = `<linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7FE6BE"/><stop offset="0.5" stop-color="${accent}"/><stop offset="1" stop-color="#2A9C74"/></linearGradient>`;
  defs += isCircle
    ? `<clipPath id="av"><circle cx="${c}" cy="${c}" r="${R}"/></clipPath>`
    : `<clipPath id="av"><rect x="${c - R}" y="${c - R}" width="${2 * R}" height="${2 * R}" rx="${corner}"/></clipPath>`;

  const bg = cfg.avatarTransparent ? "" : `<rect width="${S}" height="${S}" fill="${t.bg}"/>`;

  // guilloché frame behind the photo
  let frame = "";
  if (cfg.ring === "guilloche") {
    frame += guillocheMarkup({ cx: c, cy: c, scale: (R + ringW * 1.8) / 44, accent, withCore: false, withNodes: false, opacity: 0.9, strokeWidth: 0.8 });
  }

  // photo or placeholder
  let photo = "";
  if (cfg.imageDataUrl) {
    photo = `<image href="${cfg.imageDataUrl}" x="${c - R}" y="${c - R}" width="${2 * R}" height="${2 * R}" preserveAspectRatio="xMidYMid slice" clip-path="url(#av)"/>`;
  } else {
    photo = isCircle
      ? `<circle cx="${c}" cy="${c}" r="${R}" fill="${t.bg2}"/>`
      : `<rect x="${c - R}" y="${c - R}" width="${2 * R}" height="${2 * R}" rx="${corner}" fill="${t.bg2}"/>`;
    photo += `<text x="${c}" y="${c}" font-family="${MONO}" font-size="34" fill="${t.muted}" text-anchor="middle" dominant-baseline="central">Upload a photo →</text>`;
  }

  // ring
  let ring = "";
  const stroke = cfg.ring === "gradient" ? "url(#ring)" : accent;
  const sw = cfg.ring === "thin" ? Math.max(4, Math.round(ringW * 0.4)) : ringW;
  const shapeStroke = (s: string, ws: number, op = 1) =>
    isCircle
      ? `<circle cx="${c}" cy="${c}" r="${R}" fill="none" stroke="${s}" stroke-width="${ws}" stroke-opacity="${op}"/>`
      : `<rect x="${c - R}" y="${c - R}" width="${2 * R}" height="${2 * R}" rx="${corner}" fill="none" stroke="${s}" stroke-width="${ws}" stroke-opacity="${op}"/>`;
  if (cfg.ring === "guilloche") {
    ring = shapeStroke(accent, 3);
  } else if (cfg.ring === "duo" && isCircle) {
    ring += `<path d="M ${c} ${c - R} A ${R} ${R} 0 0 1 ${c} ${c + R}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`;
    ring += `<path d="M ${c} ${c + R} A ${R} ${R} 0 0 1 ${c} ${c - R}" fill="none" stroke="${accent}" stroke-opacity="0.38" stroke-width="${sw}" stroke-linecap="round"/>`;
  } else {
    ring = shapeStroke(stroke, sw);
  }

  // role badge — sits over the bottom of the ring
  let badge = "";
  if (cfg.role !== "none") {
    const label = (ROLES[cfg.role] || "").toUpperCase();
    badge = roleBadgeMarkup({ cx: c, cy: c + R - 28, fontSize: 36, accent, accentSoft: t.accentSoft, label, roleKey: cfg.role, style: "solid" }).svg;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><defs>${defs}</defs>${bg}${frame}${photo}${ring}${badge}</svg>`;
}
