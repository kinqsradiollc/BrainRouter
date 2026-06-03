/**
 * buildEditorSVG — render an EditorDoc to a self-contained SVG string. Same
 * output feeds the live preview and SVG/PNG export, so the editor is true
 * WYSIWYG + vector. Pure (no React).
 */

import type { EditorDoc, Layer, TextLayer, ImageLayer, LogoLayer, ShapeLayer, BadgeLayer } from "./types";
import { guillocheMarkup } from "../brandMark";
import { FONT, MONO, esc, lockupMarkup } from "../brandShared";
import { roleBadgeMarkup } from "../roleBadge";

/** Translucent wash of a hex colour, for the glass badge fill. */
function softFill(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "rgba(52,194,142,0.16)";
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.16)`;
}

function renderText(l: TextLayer, defs: { s: string }): string {
  const ff = l.fontFamily === "mono" ? MONO : FONT;
  const anchor = l.align === "left" ? "start" : l.align === "center" ? "middle" : "end";
  const tx = l.align === "left" ? l.x : l.align === "center" ? l.x + l.w / 2 : l.x + l.w;
  const lines = (l.text && l.text.length ? l.text : " ").split("\n");
  const lh = l.fontSize * l.lineHeight;
  let attr = "";
  if (l.effect === "shadow") {
    const id = `sh-${l.id}`;
    const d = (l.fontSize * 0.06).toFixed(1);
    defs.s += `<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="${d}" stdDeviation="${d}" flood-color="${l.effectColor}" flood-opacity="0.5"/></filter>`;
    attr = ` filter="url(#${id})"`;
  } else if (l.effect === "outline") {
    attr = ` stroke="${l.effectColor}" stroke-width="${Math.max(1, l.fontSize * 0.06).toFixed(1)}" paint-order="stroke" stroke-linejoin="round"`;
  }
  const spans = lines.map((ln, i) => `<tspan x="${tx.toFixed(1)}" dy="${i === 0 ? 0 : lh.toFixed(1)}">${esc(ln)}</tspan>`).join("");
  return `<text x="${tx.toFixed(1)}" y="${(l.y + l.fontSize * 0.82).toFixed(1)}" font-family="${ff}" font-size="${l.fontSize}" font-weight="${l.weight}" letter-spacing="${l.letterSpacing}" fill="${l.color}" text-anchor="${anchor}"${attr}>${spans}</text>`;
}

function renderImage(l: ImageLayer, defs: { s: string }): string {
  if (!l.src) {
    return `<rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="${l.radius}" fill="#1b1f24" stroke="#2a2f37"/>`;
  }
  const id = `clip-${l.id}`;
  defs.s += `<clipPath id="${id}"><rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="${l.radius}"/></clipPath>`;
  return `<image href="${l.src}" x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`;
}

function renderLogo(l: LogoLayer): string {
  return lockupMarkup({ x: l.x, y: l.y + l.h / 2, h: l.h, accent: l.color, textColor: l.color, lockup: l.lockup }).svg;
}

function renderShape(l: ShapeLayer): string {
  const common = `fill="${l.fill === "none" ? "none" : l.fill}" stroke="${l.stroke}" stroke-width="${l.strokeWidth}"`;
  if (l.shape === "ellipse") return `<ellipse cx="${l.x + l.w / 2}" cy="${l.y + l.h / 2}" rx="${l.w / 2}" ry="${l.h / 2}" ${common}/>`;
  if (l.shape === "line") return `<line x1="${l.x}" y1="${l.y}" x2="${l.x + l.w}" y2="${l.y + l.h}" stroke="${l.stroke}" stroke-width="${l.strokeWidth}" stroke-linecap="round"/>`;
  return `<rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="${l.radius}" ${common}/>`;
}

function renderBadge(l: BadgeLayer): string {
  const fs = l.h / 2.15;
  return roleBadgeMarkup({
    cx: l.x + l.w / 2,
    cy: l.y + l.h / 2,
    fontSize: fs,
    accent: l.color,
    accentSoft: softFill(l.color),
    label: l.label && l.label.length ? l.label : "FOUNDER",
    roleKey: l.roleKey,
    style: l.style,
  }).svg;
}

function renderLayer(l: Layer, defs: { s: string }): string {
  if (!l.visible) return "";
  let inner = "";
  if (l.type === "text") inner = renderText(l, defs);
  else if (l.type === "image") inner = renderImage(l, defs);
  else if (l.type === "logo") inner = renderLogo(l);
  else if (l.type === "badge") inner = renderBadge(l);
  else inner = renderShape(l);
  const cx = l.x + l.w / 2;
  const cy = l.y + l.h / 2;
  const transform = l.rotation ? ` transform="rotate(${l.rotation} ${cx.toFixed(1)} ${cy.toFixed(1)})"` : "";
  const op = l.opacity < 1 ? ` opacity="${l.opacity}"` : "";
  return transform || op ? `<g${transform}${op}>${inner}</g>` : inner;
}

export function buildEditorSVG(doc: EditorDoc, opts?: { hideId?: string }): string {
  const { width: w, height: h, background: b } = doc;
  const defs = { s: "" };

  // background
  let bg = "";
  if (b.type !== "transparent") {
    if (b.type === "gradient") {
      defs.s += `<linearGradient id="bg" gradientTransform="rotate(${b.angle} 0.5 0.5)"><stop offset="0" stop-color="${b.from}"/><stop offset="1" stop-color="${b.to}"/></linearGradient>`;
      bg += `<rect width="${w}" height="${h}" fill="url(#bg)"/>`;
    } else if (b.type === "image" && b.src) {
      bg += `<rect width="${w}" height="${h}" fill="${b.color}"/>`;
      bg += `<image href="${b.src}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>`;
    } else {
      bg += `<rect width="${w}" height="${h}" fill="${b.color}"/>`;
      if (b.type === "grid") {
        defs.s += `<pattern id="dots" width="34" height="34" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.6" fill="${b.accent}" fill-opacity="0.18"/></pattern>`;
        defs.s += `<radialGradient id="df" cx="0.3" cy="0.35" r="0.85"><stop offset="0" stop-color="#fff"/><stop offset="0.75" stop-color="#fff" stop-opacity="0"/></radialGradient><mask id="dm"><rect width="${w}" height="${h}" fill="url(#df)"/></mask>`;
        bg += `<rect width="${w}" height="${h}" fill="url(#dots)" mask="url(#dm)"/>`;
      } else if (b.type === "rosette") {
        const portrait = h > w * 1.2;
        bg += guillocheMarkup({ cx: portrait ? w * 0.5 : w * 0.95, cy: portrait ? h * 0.24 : h * 0.5, scale: (portrait ? w * 1.15 : h * 1.3) / 88, accent: b.accent, withCore: false, withNodes: false, opacity: 0.5, strokeWidth: 0.9 });
      }
    }
  }

  const layers = doc.layers.map((l) => (opts?.hideId && l.id === opts.hideId ? "" : renderLayer(l, defs))).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}"><defs>${defs.s}</defs>${bg}${layers}</svg>`;
}
