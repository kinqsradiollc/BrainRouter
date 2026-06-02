/**
 * buildPosterSVG — turns a BrandConfig into a complete, self-contained SVG
 * string. Used both for the live preview (rendered via the DOM) and for export
 * (serialized to .svg, or rasterized to PNG). Pure (no React) so it can be
 * exercised headlessly. Vector-native — which is why the studio can export true
 * SVG, not just a flattened PNG.
 */

import { SIZES, THEMES, type BrandConfig } from "./brandPresets";
import { guillocheMarkup } from "./brandMark";

const FONT = "Geist, Inter, -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif";
const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > maxChars) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + " " + w : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function tspans(lines: string[], x: number, lineH: number): string {
  return lines.map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lineH}">${esc(l)}</tspan>`).join("");
}

export function buildPosterSVG(cfg: BrandConfig): string {
  const { w, h } = SIZES[cfg.preset];
  const t = THEMES[cfg.theme];
  const P = Math.round(Math.min(w, h) * 0.075);
  const minD = Math.min(w, h);
  const center = cfg.template === "quote" || cfg.template === "minimal";
  const anchor = center ? "middle" : "start";
  const cxText = center ? w / 2 : P;

  // ---- defs ----
  let defs = "";
  defs += `<linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.bg2}"/><stop offset="1" stop-color="${t.bg}"/></linearGradient>`;
  defs += `<radialGradient id="aura" cx="0.22" cy="0.15" r="0.9"><stop offset="0" stop-color="${t.accent}" stop-opacity="0.28"/><stop offset="0.55" stop-color="${t.accent}" stop-opacity="0"/></radialGradient>`;
  defs += `<pattern id="dots" width="34" height="34" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.6" fill="${t.accent}" fill-opacity="0.18"/></pattern>`;
  defs += `<radialGradient id="dotFade" cx="0.3" cy="0.35" r="0.85"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="0.75" stop-color="#fff" stop-opacity="0"/></radialGradient>`;
  defs += `<mask id="dotMask"><rect width="${w}" height="${h}" fill="url(#dotFade)"/></mask>`;

  // ---- background ----
  let bg = `<rect width="${w}" height="${h}" fill="${cfg.background === "gradient" ? "url(#bgGrad)" : t.bg}"/>`;
  if (cfg.background === "grid") {
    bg += `<rect width="${w}" height="${h}" fill="url(#dots)" mask="url(#dotMask)"/>`;
  } else if (cfg.background === "aura") {
    bg += `<rect width="${w}" height="${h}" fill="url(#aura)"/>`;
  } else if (cfg.background === "rosette") {
    // big faint guilloché bleeding off the right edge (or top for tall formats)
    const portrait = h > w * 1.2;
    const rcx = portrait ? w * 0.5 : w * 0.96;
    const rcy = portrait ? h * 0.26 : h * 0.5;
    const rScale = (portrait ? w * 1.15 : h * 1.25) / 88;
    bg += guillocheMarkup({ cx: rcx, cy: rcy, scale: rScale, accent: t.accent, withCore: false, withNodes: false, opacity: 0.5, strokeWidth: 0.9 });
    bg += `<rect width="${w}" height="${h}" fill="url(#aura)" opacity="0.6"/>`;
  }

  // ---- top band: logo lockup + version badge ----
  let top = "";
  const markD = Math.round(minD * 0.07);
  if (cfg.showLogo && !center) {
    const my = P + markD / 2;
    top += guillocheMarkup({ cx: P + markD / 2, cy: my, scale: markD / 88, accent: t.accent });
    const wm = Math.round(markD * 0.62);
    top += `<text x="${P + markD + markD * 0.42}" y="${my}" font-family="${FONT}" font-size="${wm}" font-weight="600" letter-spacing="-0.02em" fill="${t.text}" dominant-baseline="central">BrainRouter</text>`;
  }
  if (cfg.showVersion && cfg.version.trim()) {
    const vs = Math.round(minD * 0.026);
    const vw = cfg.version.length * vs * 0.62 + vs * 1.8;
    const vh = Math.round(vs * 2.1);
    const vx = w - P - vw;
    const vy = P + (cfg.showLogo && !center ? markD / 2 - vh / 2 : 0);
    top += `<g><rect x="${vx}" y="${vy}" width="${vw.toFixed(0)}" height="${vh}" rx="${vh / 2}" fill="${t.accentSoft}" stroke="${t.accent}" stroke-opacity="0.45"/>`;
    top += `<text x="${vx + vw / 2}" y="${vy + vh / 2}" font-family="${MONO}" font-size="${vs}" font-weight="600" letter-spacing="0.04em" fill="${t.accent}" text-anchor="middle" dominant-baseline="central">${esc(cfg.version)}</text></g>`;
  }

  // ---- headline block (centered as a group vertically) ----
  let block = "";
  if (cfg.template !== "minimal") {
    const hlBase = cfg.template === "quote" ? 0.06 : cfg.preset === "header" ? 0.05 : 0.054;
    const hlSize = Math.min(Math.round(w * hlBase), Math.round(h * 0.2));
    const ebSize = Math.max(14, Math.round(hlSize * 0.27));
    const subSize = Math.round(hlSize * 0.42);
    const contentW = w - 2 * P;
    const hlLines = wrap(cfg.headline, Math.max(8, Math.floor(contentW / (hlSize * 0.56))));
    const showSub = cfg.template !== "quote" && !!cfg.subhead.trim();
    const subLines = showSub ? wrap(cfg.subhead, Math.max(12, Math.floor(contentW / (subSize * 0.54)))) : [];
    const showEyebrow = cfg.template !== "quote" && !!cfg.eyebrow.trim();

    const hlLineH = hlSize * 1.1;
    const subLineH = subSize * 1.45;
    const ebBlock = showEyebrow ? ebSize + hlSize * 0.5 : 0;
    const hlBlock = hlLines.length * hlLineH;
    const subBlock = subLines.length ? subLineH * (subLines.length - 1) + subSize + hlSize * 0.55 : 0;
    const total = ebBlock + hlBlock + subBlock;
    // vertical center, biased slightly down so the top band has air
    let y = Math.max(P + markD * 1.6, (h - total) / 2 + (center ? 0 : minD * 0.04));

    if (showEyebrow) {
      block += `<text x="${cxText}" y="${y + ebSize}" font-family="${MONO}" font-size="${ebSize}" font-weight="600" letter-spacing="0.18em" fill="${t.accent}" text-anchor="${anchor}">${esc(cfg.eyebrow.toUpperCase())}</text>`;
      y += ebBlock;
    }
    block += `<text x="${cxText}" y="${y + hlSize}" font-family="${FONT}" font-size="${hlSize}" font-weight="600" letter-spacing="-0.025em" fill="${t.text}" text-anchor="${anchor}">${tspans(hlLines, cxText, hlLineH)}</text>`;
    y += hlBlock;
    if (subLines.length) {
      block += `<text x="${cxText}" y="${y + hlSize * 0.55 + subSize}" font-family="${FONT}" font-size="${subSize}" font-weight="400" fill="${t.sub}" text-anchor="${anchor}">${tspans(subLines, cxText, subLineH)}</text>`;
    }
  } else {
    // minimal: big centered lockup
    const md = Math.round(minD * 0.26);
    block += guillocheMarkup({ cx: w / 2, cy: h / 2 - md * 0.28, scale: md / 88, accent: t.accent });
    block += `<text x="${w / 2}" y="${h / 2 + md * 0.5}" font-family="${FONT}" font-size="${Math.round(md * 0.34)}" font-weight="600" letter-spacing="-0.02em" fill="${t.text}" text-anchor="middle">BrainRouter</text>`;
    if (cfg.subhead.trim())
      block += `<text x="${w / 2}" y="${h / 2 + md * 0.5 + Math.round(md * 0.34) * 1.4}" font-family="${MONO}" font-size="${Math.round(md * 0.13)}" letter-spacing="0.1em" fill="${t.sub}" text-anchor="middle">${esc(cfg.subhead.toUpperCase())}</text>`;
  }

  // ---- footer ----
  let footer = "";
  if (cfg.template !== "minimal") {
    const fs = Math.max(13, Math.round(minD * 0.02));
    footer += `<text x="${P}" y="${h - P}" font-family="${MONO}" font-size="${fs}" letter-spacing="0.04em" fill="${t.muted}">brainrouter.dev</text>`;
    footer += `<text x="${w - P}" y="${h - P}" font-family="${MONO}" font-size="${fs}" letter-spacing="0.04em" fill="${t.muted}" text-anchor="end">memory-first AI</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}"><defs>${defs}</defs>${bg}${top}${block}${footer}</svg>`;
}
