/**
 * buildAvatarSVG — a 1024² profile-picture frame: the uploaded photo clipped to
 * a circle / rounded / square, wrapped in a flat branded ring with an optional
 * role badge. The coded Routed B remains present whether or not a profile photo
 * is supplied; uploaded photos are content, never the logo source.
 */

import { THEMES, ROLES, resolveAccent, type BrandConfig } from "./brandPresets";
import { ROUTED_B_ACCENT, routedBMarkup } from "../../../packages/brand/routedB";
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

  const defs = isCircle
    ? `<clipPath id="av"><circle cx="${c}" cy="${c}" r="${R}"/></clipPath>`
    : `<clipPath id="av"><rect x="${c - R}" y="${c - R}" width="${2 * R}" height="${2 * R}" rx="${corner}"/></clipPath>`;

  const bg = cfg.avatarTransparent ? "" : `<rect width="${S}" height="${S}" fill="${t.bg}"/>`;

  // Photo or coded brand avatar.
  let photo = "";
  if (cfg.imageDataUrl) {
    photo = `<image href="${cfg.imageDataUrl}" x="${c - R}" y="${c - R}" width="${2 * R}" height="${2 * R}" preserveAspectRatio="xMidYMid slice" clip-path="url(#av)"/>`;
  } else {
    photo = isCircle
      ? `<circle cx="${c}" cy="${c}" r="${R}" fill="${t.bg2}"/>`
      : `<rect x="${c - R}" y="${c - R}" width="${2 * R}" height="${2 * R}" rx="${corner}" fill="${t.bg2}"/>`;
    photo += routedBMarkup({ x: c - 150, y: c - 150, size: 300, color: t.text, accent: cfg.accent === "violet" ? ROUTED_B_ACCENT : undefined });
  }

  // ring
  let ring = "";
  const stroke = cfg.ring === "gradient" ? t.text : accent;
  const sw = cfg.ring === "thin" ? Math.max(4, Math.round(ringW * 0.4)) : ringW;
  const shapeStroke = (s: string, ws: number, op = 1) =>
    isCircle
      ? `<circle cx="${c}" cy="${c}" r="${R}" fill="none" stroke="${s}" stroke-width="${ws}" stroke-opacity="${op}"/>`
      : `<rect x="${c - R}" y="${c - R}" width="${2 * R}" height="${2 * R}" rx="${corner}" fill="none" stroke="${s}" stroke-width="${ws}" stroke-opacity="${op}"/>`;
  if (cfg.ring === "guilloche") {
    ring = shapeStroke(t.border, ringW + 10) + shapeStroke(accent, Math.max(3, Math.round(ringW * 0.28)), 0.9);
  } else if (cfg.ring === "duo" && isCircle) {
    ring += `<path d="M ${c} ${c - R} A ${R} ${R} 0 0 1 ${c} ${c + R}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`;
    ring += `<path d="M ${c} ${c + R} A ${R} ${R} 0 0 1 ${c} ${c - R}" fill="none" stroke="${accent}" stroke-opacity="0.38" stroke-width="${sw}" stroke-linecap="round"/>`;
  } else {
    ring = shapeStroke(stroke, sw);
  }

  // A small coded mark identifies photo avatars without turning the photo into
  // the brand source. Shape + boundary preserve recognition in monochrome.
  const brandSize = 92;
  const brandX = c + R - brandSize - 20;
  const brandY = c + R - brandSize - 20;
  const brand = cfg.imageDataUrl
    ? `<g><rect x="${brandX - 14}" y="${brandY - 14}" width="${brandSize + 28}" height="${brandSize + 28}" rx="24" fill="${t.bg}" stroke="${t.border}" stroke-width="4"/>${routedBMarkup({ x: brandX, y: brandY, size: brandSize, color: t.text, accent: cfg.accent === "violet" ? ROUTED_B_ACCENT : undefined })}</g>`
    : "";

  // role badge — sits over the bottom of the ring
  let badge = "";
  if (cfg.role !== "none") {
    const label = (ROLES[cfg.role] || "").toUpperCase();
    badge = roleBadgeMarkup({ cx: c, cy: c + R - 28, fontSize: 36, accent, accentSoft: t.accentSoft, label, roleKey: cfg.role, style: "solid" }).svg;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><defs>${defs}</defs>${bg}${photo}${ring}${brand}${badge}</svg>`;
}
