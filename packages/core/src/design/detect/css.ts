/**
 * A compact CSS reader for the design detector (ADR-056 D-B1).
 *
 * Not a full CSS engine: it splits a stylesheet into rules (selector →
 * declarations), keeps @media / @supports blocks with their condition so a
 * rule can tell "inside prefers-reduced-motion" from "everywhere", records
 * @keyframes names, and parses the colours the rules reason about — hex,
 * rgb[a], hsl[a], named — into sRGB so contrast can be computed. Anything it
 * cannot read it reports as unresolvable rather than guessing; the rules
 * treat "unknown" as "no finding", never as a defect.
 */

export interface CssDeclaration { property: string; value: string; important: boolean }

export interface CssRule {
  selector: string;
  declarations: CssDeclaration[];
  /** The enclosing at-rule conditions, outermost first (e.g. `@media (prefers-reduced-motion: reduce)`). */
  conditions: string[];
  /** 1-based line of the selector in the source. */
  line: number;
}

export interface CssSheet {
  rules: CssRule[];
  keyframes: string[];
  /** True when any rule sits under a prefers-reduced-motion condition. */
  hasReducedMotionRule: boolean;
}

/** Strip comments, preserving line count so positions still map to the source. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

export function parseDeclarations(block: string): CssDeclaration[] {
  const out: CssDeclaration[] = [];
  for (const part of block.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const property = part.slice(0, i).trim().toLowerCase();
    let value = part.slice(i + 1).trim();
    if (!property || !value) continue;
    const important = /!important\s*$/i.test(value);
    if (important) value = value.replace(/!important\s*$/i, '').trim();
    out.push({ property, value, important });
  }
  return out;
}

/** Parse a stylesheet. Tolerant: an unbalanced tail is dropped, never thrown. */
export function parseCss(source: string): CssSheet {
  const css = stripComments(source);
  const rules: CssRule[] = [];
  const keyframes: string[] = [];
  const conditions: string[] = [];
  let i = 0;
  const lineAt = (idx: number): number => { let n = 1; for (let k = 0; k < idx && k < css.length; k++) if (css.charCodeAt(k) === 10) n++; return n; };
  const skipKeyframes = (start: number): number => {
    // Skip a balanced { … } block starting at the first `{` at/after `start`.
    let depth = 0; let k = start;
    for (; k < css.length; k++) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}') { depth--; if (depth === 0) return k + 1; }
    }
    return css.length;
  };
  while (i < css.length) {
    const ch = css[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '}') { conditions.pop(); i++; continue; }
    const brace = css.indexOf('{', i);
    if (brace < 0) break;
    const head = css.slice(i, brace).trim();
    if (head.startsWith('@')) {
      const name = head.split(/\s/)[0].toLowerCase();
      if (name === '@keyframes' || name === '@-webkit-keyframes') {
        keyframes.push(head.replace(/^@(?:-webkit-)?keyframes\s+/i, '').trim());
        i = skipKeyframes(brace);
        continue;
      }
      if (name === '@font-face' || name === '@page' || name === '@import' || name === '@charset') {
        i = name === '@import' || name === '@charset' ? css.indexOf(';', i) + 1 || css.length : skipKeyframes(brace);
        continue;
      }
      // @media / @supports / @container / @layer: descend.
      conditions.push(head);
      i = brace + 1;
      continue;
    }
    const close = css.indexOf('}', brace);
    if (close < 0) break;
    const declarations = parseDeclarations(css.slice(brace + 1, close));
    for (const selector of head.split(',').map((s) => s.trim()).filter(Boolean)) {
      rules.push({ selector, declarations, conditions: [...conditions], line: lineAt(i) });
    }
    i = close + 1;
  }
  return { rules, keyframes, hasReducedMotionRule: rules.some((r) => r.conditions.some((c) => /prefers-reduced-motion\s*:\s*reduce/i.test(c))) };
}

// ---- colours ----------------------------------------------------------------

export interface Rgb { r: number; g: number; b: number; a: number }

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', green: '#008000', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', navy: '#000080', purple: '#800080', violet: '#ee82ee', indigo: '#4b0082', cyan: '#00ffff', aqua: '#00ffff',
  magenta: '#ff00ff', fuchsia: '#ff00ff', yellow: '#ffff00', orange: '#ffa500', pink: '#ffc0cb', teal: '#008080', lime: '#00ff00',
  maroon: '#800000', olive: '#808000', brown: '#a52a2a', gold: '#ffd700', coral: '#ff7f50', salmon: '#fa8072', crimson: '#dc143c',
  slategray: '#708090', slategrey: '#708090', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkgray: '#a9a9a9', darkgrey: '#a9a9a9',
  dimgray: '#696969', dimgrey: '#696969', whitesmoke: '#f5f5f5', gainsboro: '#dcdcdc', transparent: 'transparent',
};

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Parse one colour value; null when it is not a literal colour (a variable, a gradient, currentColor, …). */
export function parseColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (NAMED[v] !== undefined) return NAMED[v] === 'transparent' ? { r: 0, g: 0, b: 0, a: 0 } : parseColor(NAMED[v]);
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = h.split('').map((c) => parseInt(c + c, 16));
      return { r, g, b, a: h.length === 4 ? a / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) {
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
    }
    return null;
  }
  m = v.match(/^rgba?\(\s*([\d.]+)%?\s*[, ]\s*([\d.]+)%?\s*[, ]\s*([\d.]+)%?\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/);
  if (m) {
    const a = m[4] === undefined ? 1 : m[5] === '%' ? Number(m[4]) / 100 : Number(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
  }
  m = v.match(/^hsla?\(\s*([\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/);
  if (m) {
    const [r, g, b] = hslToRgb(Number(m[1]) % 360, Number(m[2]) / 100, Number(m[3]) / 100);
    const a = m[4] === undefined ? 1 : m[5] === '%' ? Number(m[4]) / 100 : Number(m[4]);
    return { r, g, b, a };
  }
  return null;
}

/** Normalised `#rrggbb` (alpha dropped) for token comparison; null when unparseable. */
export function toHex(value: string): string | null {
  const c = parseColor(value);
  if (!c || c.a === 0) return null;
  const h = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function relativeLuminance(c: Rgb): number {
  const f = (v: number): number => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** WCAG contrast ratio; the foreground is composited over the background when translucent. */
export function contrastRatio(fg: Rgb, bg: Rgb): number {
  const over = fg.a < 1 ? { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 } : fg;
  const l1 = relativeLuminance(over), l2 = relativeLuminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Chroma-free (gray) colours: every channel within 8 of the others. */
export function isNeutral(c: Rgb): boolean {
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) <= 8;
}

export function hueOf(c: Rgb): number {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return h;
}

/** The colour stops of a gradient value, parsed where literal. */
export function gradientColors(value: string): Rgb[] {
  const inner = value.match(/gradient\((.*)\)/is)?.[1] ?? '';
  const out: Rgb[] = [];
  for (const part of inner.split(/,(?![^(]*\))/)) {
    const token = part.trim().split(/\s+/)[0];
    const c = token ? parseColor(token) : null;
    if (c) out.push(c);
  }
  return out;
}

/** A CSS length in px when the unit is px/rem/em (16px base), else null. */
export function lengthPx(value: string, base = 16): number | null {
  const m = value.trim().match(/^(-?[\d.]+)(px|rem|em)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (Number.isNaN(n)) return null;
  const u = (m[2] ?? 'px').toLowerCase();
  return u === 'px' ? n : n * base;
}
