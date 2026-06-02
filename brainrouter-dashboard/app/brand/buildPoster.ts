/**
 * buildPosterSVG — BrandConfig → self-contained poster SVG string (live preview
 * + SVG/PNG export). Text auto-fits the canvas (never overflows). Pure (no
 * React) so it can be exercised headlessly.
 */

import { SIZES, THEMES, ROLES, resolveAccent, type BrandConfig } from "./brandPresets";
import { guillocheMarkup } from "./brandMark";
import { FONT, MONO, esc, layoutText, tspans, lockupMarkup } from "./brandShared";

export function buildPosterSVG(cfg: BrandConfig): string {
  const { w, h } = SIZES[cfg.preset];
  const t = THEMES[cfg.theme];
  const accent = resolveAccent(cfg);
  const minD = Math.min(w, h);
  const P = Math.round(minD * 0.075);
  const landscape = w > h * 1.15;
  const center = cfg.template === "quote" ? true : cfg.align === "center";
  const anchor = center ? "middle" : "start";
  const cx = center ? w / 2 : P;
  const transparent = cfg.background === "transparent";

  // ---- defs ----
  let defs = "";
  defs += `<linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.bg2}"/><stop offset="1" stop-color="${t.bg}"/></linearGradient>`;
  defs += `<radialGradient id="aura" cx="0.22" cy="0.12" r="0.95"><stop offset="0" stop-color="${accent}" stop-opacity="0.3"/><stop offset="0.55" stop-color="${accent}" stop-opacity="0"/></radialGradient>`;
  defs += `<pattern id="dots" width="34" height="34" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.6" fill="${accent}" fill-opacity="0.18"/></pattern>`;
  defs += `<radialGradient id="dotFade" cx="0.3" cy="0.35" r="0.85"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="0.75" stop-color="#fff" stop-opacity="0"/></radialGradient>`;
  defs += `<mask id="dotMask"><rect width="${w}" height="${h}" fill="url(#dotFade)"/></mask>`;

  // ---- background ----
  let bg = "";
  if (!transparent) {
    bg += `<rect width="${w}" height="${h}" fill="${cfg.background === "gradient" ? "url(#bgGrad)" : t.bg}"/>`;
    if (cfg.background === "grid") bg += `<rect width="${w}" height="${h}" fill="url(#dots)" mask="url(#dotMask)"/>`;
    else if (cfg.background === "aura") bg += `<rect width="${w}" height="${h}" fill="url(#aura)"/>`;
    else if (cfg.background === "rosette") {
      const portrait = h > w * 1.2;
      const rcx = portrait ? w * 0.5 : w * 0.96;
      const rcy = portrait ? h * 0.24 : h * 0.5;
      const rScale = (portrait ? w * 1.15 : h * 1.3) / 88;
      bg += guillocheMarkup({ cx: rcx, cy: rcy, scale: rScale, accent, withCore: false, withNodes: false, opacity: 0.5, strokeWidth: 0.9 });
      bg += `<rect width="${w}" height="${h}" fill="url(#aura)" opacity="0.55"/>`;
    }
  }

  // ---- top band: lockup + version/role pills ----
  const topH = Math.round(minD * 0.072);
  const my = P + topH / 2;
  let top = "";
  if (cfg.lockup !== "wordmark" || cfg.template !== "minimal") {
    if (cfg.template !== "minimal") {
      const lk = lockupMarkup({ x: P, y: my, h: topH, accent, textColor: t.text, lockup: cfg.lockup });
      top += lk.svg;
    }
  }
  // pills (version, role) top-right, stacked
  const pills: { text: string; mono?: boolean }[] = [];
  if (cfg.showVersion && cfg.version.trim()) pills.push({ text: cfg.version, mono: true });
  if (cfg.role !== "none") pills.push({ text: ROLES[cfg.role] });
  if (cfg.template !== "minimal") {
    let py = P;
    for (const pill of pills) {
      const fs = Math.round(minD * 0.024);
      const pad = fs * 0.9;
      const pw = pill.text.length * fs * 0.6 + pad * 2;
      const ph = Math.round(fs * 2.0);
      const px = w - P - pw;
      top += `<rect x="${px.toFixed(0)}" y="${py}" width="${pw.toFixed(0)}" height="${ph}" rx="${ph / 2}" fill="${t.accentSoft}" stroke="${accent}" stroke-opacity="0.45"/>`;
      top += `<text x="${px + pw / 2}" y="${py + ph / 2}" font-family="${pill.mono ? MONO : FONT}" font-size="${fs}" font-weight="600" letter-spacing="${pill.mono ? "0.04em" : "0.02em"}" fill="${accent}" text-anchor="middle" dominant-baseline="central">${esc(pill.text)}</text>`;
      py += ph + Math.round(fs * 0.6);
    }
  }

  // ---- body ----
  let body = "";
  if (cfg.template === "minimal") {
    const md = Math.round(minD * 0.24);
    const lk = lockupMarkup({ x: 0, y: 0, h: md, accent, textColor: t.text, lockup: cfg.lockup });
    // center the lockup as a group
    const gx = (w - lk.width) / 2;
    body += `<g transform="translate(${gx.toFixed(1)} ${h / 2})">${lk.svg}</g>`;
    if (cfg.subhead.trim())
      body += `<text x="${w / 2}" y="${h / 2 + md * 0.85}" font-family="${MONO}" font-size="${Math.round(md * 0.13)}" letter-spacing="0.12em" fill="${t.sub}" text-anchor="middle">${esc(cfg.subhead.toUpperCase())}</text>`;
  } else {
    const footerH = Math.round(minD * 0.05);
    const availTop = P + topH + Math.round(minD * 0.05);
    const availBottom = h - P - footerH;
    const availH = Math.max(minD * 0.2, availBottom - availTop);
    const contentW = cfg.background === "rosette" && landscape && !center ? (w - 2 * P) * 0.62 : w - 2 * P;

    const maxHl = Math.min(Math.round(w * (cfg.template === "quote" ? 0.072 : 0.06)), Math.round(h * 0.27));
    const hasSub = cfg.template !== "quote" && !!cfg.subhead.trim();
    const hl = layoutText(cfg.headline, contentW, availH * (hasSub ? 0.62 : 0.9), maxHl, Math.round(maxHl * 0.34), 1.1);
    const ebSize = Math.max(13, Math.round(hl.font * 0.3));
    const sub = hasSub ? layoutText(cfg.subhead, contentW, availH * 0.32, Math.round(hl.font * 0.46), 15, 1.4) : { font: 0, lines: [] };
    const showEyebrow = cfg.template !== "quote" && !!cfg.eyebrow.trim();

    const ebBlock = showEyebrow ? ebSize + hl.font * 0.5 : 0;
    const hlBlock = hl.lines.length * hl.font * 1.1;
    const subGap = sub.lines.length ? hl.font * 0.55 : 0;
    const subBlock = sub.lines.length * sub.font * 1.4;
    const stackH = ebBlock + hlBlock + subGap + subBlock;
    let y = availTop + Math.max(0, (availH - stackH) / 2);

    if (showEyebrow) {
      body += `<text x="${cx}" y="${(y + ebSize).toFixed(1)}" font-family="${MONO}" font-size="${ebSize}" font-weight="600" letter-spacing="0.18em" fill="${accent}" text-anchor="${anchor}">${esc(cfg.eyebrow.toUpperCase())}</text>`;
      y += ebBlock;
    }
    body += `<text x="${cx}" y="${(y + hl.font).toFixed(1)}" font-family="${FONT}" font-size="${hl.font}" font-weight="600" letter-spacing="-0.025em" fill="${t.text}" text-anchor="${anchor}">${tspans(hl.lines, cx, hl.font * 1.1)}</text>`;
    y += hlBlock + subGap;
    if (sub.lines.length) {
      body += `<text x="${cx}" y="${(y + sub.font).toFixed(1)}" font-family="${FONT}" font-size="${sub.font}" font-weight="400" fill="${t.sub}" text-anchor="${anchor}">${tspans(sub.lines, cx, sub.font * 1.4)}</text>`;
    }
  }

  // ---- footer ----
  let footer = "";
  if (cfg.template !== "minimal") {
    const fs = Math.max(13, Math.round(minD * 0.02));
    footer += `<text x="${P}" y="${h - P}" font-family="${MONO}" font-size="${fs}" letter-spacing="0.04em" fill="${t.muted}">brainrouter.dev</text>`;
    footer += `<text x="${w - P}" y="${h - P}" font-family="${MONO}" font-size="${fs}" letter-spacing="0.04em" fill="${t.muted}" text-anchor="end">memory-first AI</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}"><defs>${defs}</defs>${bg}${top}${body}${footer}</svg>`;
}
