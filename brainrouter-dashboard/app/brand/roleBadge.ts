/**
 * Shared role badge — a pill with a per-role icon + label, in a "glass"
 * (translucent fill + accent border + accent text) or "solid" (accent fill +
 * dark text) style. Used by the poster Role card and the avatar/PFP frame so
 * they look consistent and intentional. Pure (no React).
 */

import { FONT, esc } from "./brandShared";

type Icon = { d: string; stroke?: boolean };
const STAR: Icon = { d: "M12 2l2.9 6.3 6.8.6-5.1 4.5 1.5 6.7L12 17l-6.1 3.1 1.5-6.7L3.3 8.9l6.8-.6z" };
const BOLT: Icon = { d: "M13 2L4 14h6l-1 8 9-12h-6z" };
const SPARKLE: Icon = { d: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" };
const CHECK: Icon = { d: "M20 6L9 17l-5-5", stroke: true };
const SHIELD: Icon = { d: "M12 2.5L19.5 5.3V11C19.5 16 12 21 12 21S4.5 16 4.5 11V5.3Z", stroke: true };
const TREND: Icon = { d: "M3 17l6-6 4 4 8-8M15 7h6v6", stroke: true };
const COMPASS: Icon = { d: "M12 2.5a9.5 9.5 0 100 19 9.5 9.5 0 000-19zM14.6 9.4l-2 5.2-5.2 2 2-5.2z", stroke: true };
const LINK: Icon = { d: "M10 14a4 4 0 010-5.7l2-2a4 4 0 015.7 5.7l-1 1M14 10a4 4 0 010 5.7l-2 2a4 4 0 01-5.7-5.7l1-1", stroke: true };
const PEN: Icon = { d: "M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3", stroke: true };

const ROLE_ICONS: Record<string, Icon> = {
  founder: STAR,
  cofounder: STAR,
  founding_engineer: BOLT,
  core: SHIELD,
  engineer: BOLT,
  designer: PEN,
  advisor: COMPASS,
  investor: TREND,
  ambassador: STAR,
  partner: LINK,
  contributor: SPARKLE,
  verified: CHECK,
  early: SPARKLE,
  none: SPARKLE,
};

export function roleBadgeMarkup(opts: {
  cx: number;
  cy: number;
  fontSize: number;
  accent: string;
  accentSoft?: string;
  label: string;
  roleKey: string;
  style: "glass" | "solid";
}): { svg: string; w: number; h: number } {
  const { cx, cy, fontSize: fs, accent, label, roleKey, style } = opts;
  const ic = ROLE_ICONS[roleKey] || SPARKLE;
  const iconSize = fs * 1.15;
  const gap = fs * 0.5;
  const padX = fs * 1.05;
  const textW = label.length * fs * 0.62;
  const w = Math.round(padX * 2 + iconSize + gap + textW);
  const h = Math.round(fs * 2.1);
  const x = cx - w / 2;
  const y = cy - h / 2;
  const fg = style === "solid" ? "#06130E" : accent;
  const bgFill = style === "solid" ? accent : opts.accentSoft || "rgba(52,194,142,0.16)";
  const border = style === "solid" ? "" : ` stroke="${accent}" stroke-width="1.5"`;

  const iconX = x + padX;
  const isc = iconSize / 24;
  const inner = ic.stroke
    ? `<path d="${ic.d}" fill="none" stroke="${fg}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="${ic.d}" fill="${fg}"/>`;

  let svg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${bgFill}"${border}/>`;
  svg += `<g transform="translate(${iconX.toFixed(1)} ${(cy - iconSize / 2).toFixed(1)}) scale(${isc.toFixed(3)})">${inner}</g>`;
  svg += `<text x="${(iconX + iconSize + gap).toFixed(1)}" y="${cy}" font-family="${FONT}" font-size="${fs}" font-weight="700" letter-spacing="0.08em" fill="${fg}" text-anchor="start" dominant-baseline="central">${esc(label)}</text>`;
  return { svg, w, h };
}
