/**
 * The static design engine (ADR-056 D-B1).
 *
 * Input: files the caller already read (HTML, CSS, or JSX/TSX/Svelte/Vue
 * templates, normalised to markup). The engine builds a document model —
 * cheerio DOM with source lines, every stylesheet parsed, and for each element
 * its EFFECTIVE declarations (matching stylesheet rules in order, then the
 * inline style) — and runs every catalogue rule over it. Findings carry the
 * review finding vocabulary (file, line, snippet, severity) plus the rule id
 * and its guideline, so they render on the same cards a code review does.
 *
 * Determinism over cleverness: no browser, no cascade specificity beyond
 * source order + inline, no inheritance beyond what a rule asks for
 * explicitly. Where a rule cannot resolve what it needs (a `var()` colour, an
 * `em` inside an unknown context) it stays silent; the browser engine (D-B1's
 * second half) is where computed values live.
 */
import { load, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { DESIGN_RULES, DESIGN_RULE_BY_ID, DESIGN_RULES_VERSION, OVERUSED_FONTS, BUZZWORDS, type DesignRule } from './rules.js';
import { parseCss, parseDeclarations, parseColor, toHex, contrastRatio, isNeutral, hueOf, gradientColors, lengthPx, relativeLuminance, type CssSheet, type CssDeclaration } from './css.js';
import { primaryFamily, type DesignSystemTokens } from './designSystem.js';
import { isSuppressed, EMPTY_SUPPRESSIONS, type DesignSuppressions } from './suppressions.js';

export interface DesignInputFile {
  /** Workspace-relative POSIX path (drives suppressions and the finding's `file`). */
  path: string;
  content: string;
}

export interface DesignFinding {
  rule: string;
  category: DesignRule['category'];
  severity: DesignRule['severity'];
  advisory?: boolean;
  file: string;
  line?: number;
  /** A short verbatim excerpt (selector, tag, or text) for the card. */
  snippet?: string;
  message: string;
  guideline: string;
  /** The matched value when the rule has one (font, colour, radius) — what a suppression can name. */
  value?: string;
}

export interface DesignDetectOptions {
  tokens?: DesignSystemTokens | null;
  suppressions?: DesignSuppressions;
  /** Only these rule ids (default: all). */
  rules?: string[];
}

export interface DesignDetectResult {
  catalogVersion: string;
  findings: DesignFinding[];
  /** Findings removed by suppressions, with the reason, so silence is visible. */
  suppressed: Array<DesignFinding & { reason: string }>;
  files: number;
  rulesRun: string[];
  /** Files the engine could not model (unsupported extension). */
  skipped: string[];
  /** Counts by severity over non-advisory findings. */
  errors: number;
  warnings: number;
}

// ---- document model ---------------------------------------------------------

const MARKUP_EXT = /\.(html?|xhtml|svelte|vue|jsx|tsx|astro|mdx)$/i;
const CSS_EXT = /\.(css|scss|less)$/i;

/** Normalise JSX/TSX-ish markup so the HTML parser sees class/style attributes. Best-effort, lossy by design. */
export function normaliseMarkup(path: string, content: string): string {
  if (!/\.(jsx|tsx|mdx)$/i.test(path)) return content;
  return content
    .replace(/className=/g, 'class=')
    .replace(/htmlFor=/g, 'for=')
    // style={{ color: 'red', fontSize: 12 }} → style="color:red;font-size:12px"
    .replace(/style=\{\{([\s\S]*?)\}\}/g, (_m, body: string) => {
      const decls = body.split(/,(?![^(]*\))/).map((p) => {
        const i = p.indexOf(':');
        if (i < 0) return '';
        const prop = p.slice(0, i).trim().replace(/^['"]|['"]$/g, '').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        let val = p.slice(i + 1).trim().replace(/^['"`]|['"`]$/g, '');
        if (/^-?\d+(\.\d+)?$/.test(val) && !/^(opacity|z-index|font-weight|line-height|flex|order)$/.test(prop)) val += 'px';
        return prop && val ? `${prop}:${val}` : '';
      }).filter(Boolean).join(';');
      return `style="${decls}"`;
    })
    // {expr} attribute values and JSX-child expressions → dropped; the surrounding
    // JS (function bodies, imports) is left alone and parses as inert text.
    .replace(/=\{[^}]*\}/g, '=""')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/>\s*\{[^{}]*\}\s*</g, '><');
}

interface ModelElement {
  el: Element;
  tag: string;
  line: number;
  declarations: Map<string, string>;
  text: string;
}

interface Document {
  file: string;
  $: CheerioAPI;
  sheet: CssSheet;
  elements: ModelElement[];
  /** Every stylesheet source in this document (own <style> blocks + inline), for text-level rules. */
  cssText: string;
}

function textOf($: CheerioAPI, el: Element): string {
  return $(el).text().replace(/\s+/g, ' ').trim();
}

function buildDocument(file: DesignInputFile, externalSheets: CssSheet[]): Document {
  const html = normaliseMarkup(file.path, file.content);
  const $ = load(html, { sourceCodeLocationInfo: true } as Record<string, unknown>);
  const styleBlocks = $('style').map((_i, s) => $(s).text()).get().join('\n');
  const sheet = parseCss(styleBlocks);
  const sheets = [...externalSheets, sheet];
  const elements: ModelElement[] = [];
  $('*').each((_i, node) => {
    const el = node as Element;
    const tag = el.tagName?.toLowerCase();
    if (!tag || tag === 'html' || tag === 'head' || tag === 'script' || tag === 'style' || tag === 'meta' || tag === 'link' || tag === 'title') return;
    const declarations = new Map<string, string>();
    for (const s of sheets) {
      for (const r of s.rules) {
        if (r.conditions.length) continue; // media-conditional rules are not "effective everywhere"
        let matches = false;
        try { matches = $(el).is(r.selector); } catch { matches = false; }
        if (!matches) continue;
        for (const d of r.declarations) declarations.set(d.property, d.value);
      }
    }
    const inline = el.attribs?.style;
    if (inline) for (const d of parseDeclarations(inline)) declarations.set(d.property, d.value);
    const loc = (el as unknown as { sourceCodeLocation?: { startLine?: number } }).sourceCodeLocation;
    elements.push({ el, tag, line: loc?.startLine ?? 0, declarations, text: textOf($, el) });
  });
  return { file: file.path, $, sheet, elements, cssText: styleBlocks };
}

// ---- rules ------------------------------------------------------------------

type Emit = (rule: string, line: number | undefined, message: string, snippet?: string, value?: string) => void;

const BODY_TAGS = new Set(['p', 'li', 'td', 'dd', 'blockquote', 'figcaption', 'summary']);
const CARD_LIKE = (d: Map<string, string>): boolean => {
  const border = d.get('border') ?? '', shadow = d.get('box-shadow') ?? '', radius = d.get('border-radius') ?? '';
  return (/\d/.test(border) && !/none|0(px)?\b/.test(border)) || (!!shadow && shadow !== 'none') || (!!radius && lengthPx(radius) !== null && lengthPx(radius)! >= 6 && (!!d.get('background') || !!d.get('background-color')));
};

function selectorSnippet(doc: Document, m: ModelElement): string {
  const cls = m.el.attribs?.class?.split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join('') ?? '';
  return `<${m.tag}${cls}>`;
}

function runElementRules(doc: Document, emit: Emit, tokens: DesignSystemTokens | null | undefined): void {
  const { elements, $ } = doc;
  // Body-text baseline: the most common font-size among body tags, else 16.
  const bodySizes = elements.filter((m) => BODY_TAGS.has(m.tag)).map((m) => lengthPx(m.declarations.get('font-size') ?? '')).filter((n): n is number => n !== null);
  const bodyPx = bodySizes.length ? bodySizes.sort((a, b) => a - b)[Math.floor(bodySizes.length / 2)] : 16;
  const headingPx: number[] = [];
  let lastHeading = 0;
  let firstHeadingSeen = false;

  for (const m of elements) {
    const d = m.declarations;
    const snip = selectorSnippet(doc, m);

    // side-stripe-border
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const v = d.get(`border-${side}`) ?? '';
      const w = lengthPx(v.split(/\s+/)[0] ?? '');
      const color = v.split(/\s+/).map(parseColor).find((c) => c);
      if (w !== null && w >= 2 && color && !isNeutral(color) && CARD_LIKE(d) === false && (d.get('border') === undefined)) {
        emit('side-stripe-border', m.line, `${snip} has a ${w}px coloured border-${side} accent.`, snip);
        break;
      }
    }
    // gradient-text
    const clip = d.get('background-clip') ?? d.get('-webkit-background-clip') ?? '';
    if (/text/i.test(clip) && /gradient\(/i.test(d.get('background') ?? d.get('background-image') ?? '')) {
      emit('gradient-text', m.line, `${snip} fills text with a gradient.`, snip);
    }
    // ai-palette: violet→blue gradient, or cyan-ish text on near-black
    const bgVal = d.get('background') ?? d.get('background-image') ?? '';
    if (/gradient\(/i.test(bgVal)) {
      const stops = gradientColors(bgVal).filter((c) => !isNeutral(c));
      const hues = stops.map(hueOf);
      if (hues.length >= 2 && hues.some((h) => h >= 250 && h <= 300) && hues.some((h) => h >= 200 && h <= 250)) {
        emit('ai-palette', m.line, `${snip} uses a violet-to-blue gradient.`, snip, 'violet-blue gradient');
      }
    }
    const fg = parseColor(d.get('color') ?? ''), bg = parseColor(d.get('background-color') ?? (/^(#|rgb|hsl|[a-z]+$)/i.test(bgVal) ? bgVal : ''));
    if (fg && bg && !isNeutral(fg) && relativeLuminance(bg) < 0.03 && hueOf(fg) >= 170 && hueOf(fg) <= 200 && m.text.length > 0) {
      emit('ai-palette', m.line, `${snip} sets cyan text on a near-black surface.`, snip, 'cyan-on-black');
    }
    // nested-cards
    if (CARD_LIKE(d)) {
      const parentCard = $(m.el).parents().toArray().some((p) => { const pm = elements.find((e) => e.el === p); return !!pm && CARD_LIKE(pm.declarations); });
      if (parentCard) emit('nested-cards', m.line, `${snip} is a card inside another card.`, snip);
    }
    // glow-halo: zero-offset coloured shadow with blur
    const shadow = d.get('box-shadow') ?? '';
    if (shadow && shadow !== 'none') {
      for (const part of shadow.split(/,(?![^(]*\))/)) {
        const toks = part.trim().split(/\s+/);
        const nums = toks.map((t) => lengthPx(t)).filter((n): n is number => n !== null);
        const color = toks.map(parseColor).find((c) => c);
        if (nums.length >= 3 && nums[0] === 0 && nums[1] === 0 && nums[2] > 0 && color && !isNeutral(color) && color.a > 0) {
          emit('glow-halo', m.line, `${snip} wears a zero-offset coloured glow (${part.trim()}).`, snip);
          break;
        }
      }
    }
    // bounce-easing
    const timing = [d.get('transition'), d.get('transition-timing-function'), d.get('animation'), d.get('animation-timing-function')].filter(Boolean).join(' ');
    const bezier = timing.match(/cubic-bezier\(([^)]+)\)/i);
    if (bezier) {
      const [, y1, , y2] = bezier[1].split(',').map((s) => Number(s.trim()));
      if (y1 > 1.05 || y2 > 1.05 || y1 < -0.05 || y2 < -0.05) emit('bounce-easing', m.line, `${snip} eases with an overshooting curve.`, snip);
    }
    // pulsing-dot
    const anim = d.get('animation') ?? '';
    if (/infinite/i.test(anim) && /pulse|blink|ping|glow/i.test(anim) && m.text.length < 3) emit('pulsing-dot', m.line, `${snip} pulses forever.`, snip);
    // marquee
    if (m.tag === 'marquee') emit('marquee', m.line, 'A <marquee> element.', '<marquee>');
    // eyebrow-label + numbered-sections + icon-tile-stack + headings
    if (/^h[1-6]$/.test(m.tag)) {
      const level = Number(m.tag[1]);
      const size = lengthPx(d.get('font-size') ?? '');
      if (size !== null) headingPx.push(size);
      if (firstHeadingSeen && level > lastHeading + 1) emit('skipped-heading', m.line, `<${m.tag}> follows <h${lastHeading}> — a level was skipped.`, snip);
      firstHeadingSeen = true; lastHeading = level;
      const prev = $(m.el).prev().get(0) as Element | undefined;
      const pm = prev ? elements.find((e) => e.el === prev) : undefined;
      if (pm && pm.text.length > 0 && pm.text.length <= 40 && /^(span|p|div|small)$/.test(pm.tag) && (/uppercase/i.test(pm.declarations.get('text-transform') ?? '') || pm.text === pm.text.toUpperCase())) {
        emit('eyebrow-label', pm.line, `"${pm.text}" sits as an eyebrow above <${m.tag}>.`, `<${pm.tag}>`);
      }
      if (pm && /^0\d$/.test(pm.text.trim())) emit('numbered-sections', pm.line, `"${pm.text.trim()}" numbers the section above <${m.tag}>.`, `<${pm.tag}>`);
      if (pm && !pm.text && pm.declarations.get('border-radius') && (pm.el.children.some((c) => (c as Element).tagName === 'svg') || /icon/i.test(pm.el.attribs?.class ?? ''))) {
        emit('icon-tile-stack', pm.line, `An icon tile stacks above <${m.tag}>.`, `<${pm.tag}>`);
      }
    }
    // text rules on body-ish elements
    if (BODY_TAGS.has(m.tag) && m.text.length >= 40) {
      const fs = lengthPx(d.get('font-size') ?? '');
      if (fs !== null && fs < 12) emit('tiny-text', m.line, `${snip} body copy at ${fs}px.`, snip);
      const lh = d.get('line-height');
      if (lh && /^[\d.]+$/.test(lh) && Number(lh) < 1.2) emit('tight-leading', m.line, `${snip} line-height ${lh}.`, snip);
      if (/justify/i.test(d.get('text-align') ?? '')) emit('justified-text', m.line, `${snip} is justified.`, snip);
      if (/uppercase/i.test(d.get('text-transform') ?? '')) emit('all-caps-body', m.line, `${snip} body copy in all caps.`, snip);
      const ls = d.get('letter-spacing');
      const lsEm = ls ? (ls.endsWith('em') ? Number(ls.replace('em', '')) : lengthPx(ls) !== null ? lengthPx(ls)! / (fs ?? bodyPx) : null) : null;
      if (lsEm !== null && lsEm > 0.05) emit('wide-tracking', m.line, `${snip} letter-spacing ${ls}.`, snip);
    }
    // gray-on-color + low-contrast (own colour vs own background only — no inheritance guessing)
    if (fg && bg && m.text.length > 0 && bg.a > 0) {
      if (isNeutral(fg) && !isNeutral(bg) && fg.a > 0) emit('gray-on-color', m.line, `${snip} sets gray text on a coloured background.`, snip);
      const ratio = contrastRatio(fg, bg);
      const size = lengthPx(d.get('font-size') ?? '') ?? bodyPx;
      const bold = /^(bold|[6-9]00)$/.test(d.get('font-weight') ?? '');
      const large = size >= 24 || (size >= 18.66 && bold);
      if (ratio < (large ? 3 : 4.5)) emit('low-contrast', m.line, `${snip} contrast ${ratio.toFixed(2)}:1 (${d.get('color')} on ${d.get('background-color') ?? bgVal}).`, snip);
    }
    // missing-alt
    if (m.tag === 'img' && m.el.attribs?.alt === undefined) emit('missing-alt', m.line, '<img> without alt.', '<img>');
    // unlabelled-control
    if (/^(input|select|textarea)$/.test(m.tag) && !/^(hidden|submit|button|reset|image)$/.test(m.el.attribs?.type ?? '')) {
      const a = m.el.attribs ?? {};
      const id = a.id;
      const labelled = !!a['aria-label'] || !!a['aria-labelledby'] || !!a.title || (id ? $(`label[for="${id}"]`).length > 0 : false) || $(m.el).parents('label').length > 0;
      if (!labelled) emit('unlabelled-control', m.line, `<${m.tag}${a.name ? ` name="${a.name}"` : ''}> has no label${a.placeholder ? ' (placeholder is not a label)' : ''}.`, `<${m.tag}>`);
    }
    // small-touch-target
    if (/^(button|a)$/.test(m.tag) && (m.tag === 'button' || m.el.attribs?.href)) {
      const h = lengthPx(d.get('height') ?? d.get('min-height') ?? '');
      const pad = lengthPx((d.get('padding') ?? '').split(/\s+/)[0] ?? '');
      if (h !== null && h < 44 && (pad === null || pad < 8)) emit('small-touch-target', m.line, `${snip} is ${h}px tall.`, snip);
    }
    // fixed-width-layout
    const w = lengthPx(d.get('width') ?? '');
    if (w !== null && w > 960 && !d.get('max-width') && /^(div|main|section|article|body|header|footer|table)$/.test(m.tag)) emit('fixed-width-layout', m.line, `${snip} is fixed at ${w}px wide.`, snip);
    // inline-color-literal
    const inline = m.el.attribs?.style ?? '';
    if (/(#[0-9a-f]{3,8}\b|rgba?\(|hsla?\()/i.test(inline)) emit('inline-color-literal', m.line, `${snip} carries a colour literal in its style attribute.`, snip);
    // design-system rules
    if (tokens) {
      const fam = d.get('font-family');
      if (fam && tokens.fonts.size) {
        const primary = primaryFamily(fam);
        if (!tokens.fonts.has(primary) && !/^(inherit|initial|unset|monospace|serif|sans-serif|system-ui)$/.test(primary)) emit('design-system-font', m.line, `${snip} uses "${primary}", not a design.md typeface.`, snip, primary);
      }
      for (const prop of ['color', 'background-color', 'border-color']) {
        const v = d.get(prop);
        const hex = v ? toHex(v) : null;
        if (v && hex && tokens.colors.size && !tokens.colors.has(hex) && hex !== '#000000' && hex !== '#ffffff') emit('design-system-color', m.line, `${snip} ${prop} ${v} is not a design.md colour.`, snip, hex);
      }
      const radius = d.get('border-radius');
      if (radius && tokens.radii.size && !tokens.radii.has(radius.trim().toLowerCase()) && radius !== '0' && radius !== '50%') emit('design-system-radius', m.line, `${snip} border-radius ${radius} is not a design.md radius.`, snip, radius);
    }
  }

  // flat-type-hierarchy (document-level)
  if (headingPx.length) {
    const maxHeading = Math.max(...headingPx);
    if (maxHeading / bodyPx < 1.25) emit('flat-type-hierarchy', undefined, `Largest heading ${maxHeading}px vs body ${bodyPx}px — no decisive step.`);
  }
  // overused-font: every declared family is on the list
  const families = new Set(elements.map((m) => m.declarations.get('font-family')).filter((f): f is string => !!f).map(primaryFamily));
  if (families.size && [...families].every((f) => OVERUSED_FONTS.includes(f))) emit('overused-font', undefined, `Only ${[...families].join(', ')} — no typeface with a voice.`, undefined, [...families][0]);
  // identical-card-grid + hero-metric: sibling groups of 3+ with the same tag shape
  const seenParents = new Set<AnyNode>();
  for (const m of elements) {
    const parent = m.el.parent;
    if (!parent || seenParents.has(parent)) continue;
    seenParents.add(parent);
    const kids = elements.filter((e) => e.el.parent === parent);
    if (kids.length < 3) continue;
    const shape = (e: ModelElement): string => $(e.el).children().toArray().map((c) => (c as Element).tagName).join('>');
    const shapes = kids.map(shape);
    if (shapes.every((s) => s === shapes[0]) && shapes[0].split('>').length >= 2 && kids.every((k) => CARD_LIKE(k.declarations))) {
      emit('identical-card-grid', kids[0].line, `${kids.length} identical cards (${shapes[0]}).`, selectorSnippet(doc, kids[0]));
    }
    const metric = kids.every((k) => { const big = k.el.children.find((c) => (c as Element).tagName && /^\d[\d,.%+kKmM]*$/.test(textOf($, c as Element))); return !!big; });
    if (metric && kids.length >= 3) emit('hero-metric', kids[0].line, `${kids.length} big-number metrics in a row.`, selectorSnippet(doc, kids[0]));
  }
  // buzzword-copy + em-dash-overuse over visible text
  const visible = elements.filter((m) => /^(p|h[1-6]|li|span|a|button|td|blockquote)$/.test(m.tag)).map((m) => m.text).join(' ');
  const lower = visible.toLowerCase();
  const hits = BUZZWORDS.filter((b) => new RegExp(`\\b${b.replace(/[-]/g, '\\-')}\\b`).test(lower));
  if (hits.length >= 2) emit('buzzword-copy', undefined, `Copy leans on ${hits.slice(0, 4).join(', ')}.`, undefined, hits[0]);
  const words = visible.split(/\s+/).filter(Boolean).length;
  const dashes = (visible.match(/—/g) ?? []).length;
  if (words >= 80 && dashes / words > 1 / 40) emit('em-dash-overuse', undefined, `${dashes} em dashes in ${words} words.`);
}

function runSheetRules(doc: Document, sheets: CssSheet[], emit: Emit): void {
  const all = [doc.sheet, ...sheets];
  const rules = all.flatMap((s) => s.rules);
  // focus-outline-removed
  const removed = rules.filter((r) => r.declarations.some((d) => d.property === 'outline' && /^(none|0)(px)?$/.test(d.value)) && /:focus/.test(r.selector) && !/:focus-visible/.test(r.selector));
  const restores = rules.some((r) => /:focus-visible/.test(r.selector) && r.declarations.some((d) => /^(outline|box-shadow|border)/.test(d.property) && !/^(none|0)(px)?$/.test(d.value)));
  for (const r of removed) if (!restores) emit('focus-outline-removed', r.line, `${r.selector} removes the outline and nothing restores focus.`, r.selector);
  // reduced-motion-ignored
  const animates = rules.some((r) => r.declarations.some((d) => (d.property === 'animation' || d.property === 'animation-name' || d.property === 'transition') && d.value !== 'none' && !/^(opacity|color|background-color|border-color)\b/.test(d.value)));
  if ((animates || all.some((s) => s.keyframes.length)) && !all.some((s) => s.hasReducedMotionRule)) {
    emit('reduced-motion-ignored', undefined, 'Animations declared and no prefers-reduced-motion rule anywhere.');
  }
  // marquee via keyframes
  for (const s of all) for (const k of s.keyframes) if (/marquee|ticker|scroll-x/i.test(k)) emit('marquee', undefined, `@keyframes ${k} scrolls content.`, `@keyframes ${k}`);
}

// ---- entry ------------------------------------------------------------------

/** Run the static engine over the given files. Pure apart from reading nothing: the caller supplies content. */
export function detectDesign(files: DesignInputFile[], opts: DesignDetectOptions = {}): DesignDetectResult {
  const suppressions = opts.suppressions ?? EMPTY_SUPPRESSIONS;
  const only = opts.rules ? new Set(opts.rules) : null;
  const findings: DesignFinding[] = [];
  const suppressed: Array<DesignFinding & { reason: string }> = [];
  const skipped: string[] = [];
  const rulesRun = new Set<string>();
  const externalSheets = files.filter((f) => CSS_EXT.test(f.path)).map((f) => ({ path: f.path, sheet: parseCss(f.content) }));

  const emitFor = (file: string): Emit => (rule, line, message, snippet, value) => {
    const def = DESIGN_RULE_BY_ID.get(rule);
    if (!def || (only && !only.has(rule))) return;
    rulesRun.add(rule);
    const f: DesignFinding = { rule, category: def.category, severity: def.severity, file, message, guideline: def.guideline };
    if (def.advisory) f.advisory = true;
    if (line) f.line = line;
    if (snippet) f.snippet = snippet;
    if (value) f.value = value;
    const s = isSuppressed(suppressions, rule, file, value);
    if (s.suppressed) suppressed.push({ ...f, reason: s.reason ?? 'suppressed' }); else findings.push(f);
  };

  let modelled = 0;
  for (const file of files) {
    if (CSS_EXT.test(file.path)) {
      // A stylesheet on its own still yields sheet-level findings.
      const sheet = parseCss(file.content);
      runSheetRules({ file: file.path, $: load(''), sheet, elements: [], cssText: file.content }, [], emitFor(file.path));
      modelled++;
      continue;
    }
    if (!MARKUP_EXT.test(file.path)) { skipped.push(file.path); continue; }
    const doc = buildDocument(file, externalSheets.map((e) => e.sheet));
    runElementRules(doc, emitFor(file.path), opts.tokens);
    runSheetRules(doc, [], emitFor(file.path));
    modelled++;
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule));
  const counted = findings.filter((f) => !f.advisory);
  return {
    catalogVersion: DESIGN_RULES_VERSION,
    findings,
    suppressed,
    files: modelled,
    rulesRun: [...rulesRun].sort(),
    skipped,
    errors: counted.filter((f) => f.severity === 'error').length,
    warnings: counted.filter((f) => f.severity === 'warning').length,
  };
}

export { DESIGN_RULES };
