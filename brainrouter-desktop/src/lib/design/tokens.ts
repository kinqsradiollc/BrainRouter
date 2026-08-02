/**
 * ADR-027 D5 (P4-1) — ONE semantic token system.
 *
 * D5 left the design language as an owner question because the reference we
 * studied carries two overlapping systems at once, and copying that imports the
 * inconsistency. The decision taken here is the **monochrome direction already
 * shipped in the desktop**: choosing the other would mean re-skinning live UI,
 * whereas this makes P4-1 a unification rather than a redesign.
 *
 * The rules this file exists to enforce:
 *
 *  1. COMPONENTS NAME ROLES, NOT COLOURS. A component asks for `surfaceRaised`
 *     or `textMuted`, never `#1a1a1a`. This is what makes a theme swap a data
 *     change rather than a search-and-replace, and it is why the scales below
 *     are keyed by role.
 *
 *  2. EVERY ROLE RESOLVES IN EVERY THEME. A token defined in dark but missing
 *     in light is invisible until someone toggles the theme — so completeness
 *     is a test, not a convention.
 *
 *  3. TEXT ON ITS OWN SURFACE MEETS CONTRAST. A dense 13px scale makes low
 *     contrast worse, not better. Each text role declares the surface it is
 *     meant to sit on, and the pairing is checked against WCAG AA rather than
 *     eyeballed.
 *
 * Values are plain data so the generator, the tests, and any future exporter
 * all read the same source.
 */

export type ThemeName = 'light' | 'dark';

/** Background layers, from the app shell backwards to the frontmost panel. */
export interface SurfaceScale {
  /** The desk the floating panels sit on. Deliberately distinct from panels. */
  desk: string;
  /** A standard panel. */
  panel: string;
  /** A panel raised above another (menus, popovers, dialogs). */
  raised: string;
  /** Recessed areas inside a panel — inputs, wells, code blocks. */
  sunken: string;
}

export interface TextScale {
  /** Primary reading colour. */
  primary: string;
  /** Secondary information: metadata, timestamps, captions. */
  muted: string;
  /** Tertiary: placeholder text, disabled labels. */
  subtle: string;
  /** Text drawn ON the accent colour. */
  onAccent: string;
}

export interface BorderScale {
  /** Ordinary separators. */
  subtle: string;
  /** Emphasised edges: focused inputs, selected rows. */
  strong: string;
}

export interface StatusScale {
  danger: string;
  warning: string;
  success: string;
  info: string;
}

export interface ThemeTokens {
  surface: SurfaceScale;
  text: TextScale;
  border: BorderScale;
  status: StatusScale;
  accent: string;
}

/**
 * Which surface each text role is designed to sit on. Contrast is a property of
 * a PAIR, so a text scale with no declared background cannot be checked at all
 * — this table is what makes rule 3 testable instead of aspirational.
 */
export const TEXT_ON_SURFACE: Record<keyof Omit<TextScale, 'onAccent'>, keyof SurfaceScale> = {
  primary: 'panel',
  muted: 'panel',
  subtle: 'panel',
};

export const THEMES: Record<ThemeName, ThemeTokens> = {
  dark: {
    surface: {
      desk: '#0b1020',
      panel: '#14161c',
      raised: '#1c1f27',
      sunken: '#0e1015',
    },
    text: {
      primary: '#f2f3f5',
      muted: '#a8adb8',
      subtle: '#7d838f',
      // The dark theme's accent is a LIGHT colour (monochrome inverts here), so
      // text drawn on it must be dark. White-on-accent scored 1.2:1 — invisible
      // — and was caught by the contrast test rather than by a person squinting
      // at a button.
      onAccent: '#14161c',
    },
    border: {
      subtle: '#262a33',
      strong: '#3d434f',
    },
    status: {
      danger: '#ff6b6b',
      warning: '#e8b339',
      success: '#4ec9a5',
      info: '#5aa9e6',
    },
    accent: '#e8eaed',
  },
  light: {
    surface: {
      desk: '#e8eaee',
      panel: '#ffffff',
      raised: '#ffffff',
      sunken: '#f4f5f7',
    },
    text: {
      primary: '#14161c',
      muted: '#5a6069',
      subtle: '#767c86',
      onAccent: '#ffffff',
    },
    border: {
      subtle: '#dfe1e6',
      strong: '#b9bdc5',
    },
    status: {
      danger: '#c8322f',
      warning: '#8a5a00',
      success: '#136f52',
      info: '#1d5fa8',
    },
    accent: '#011627',
  },
};

/**
 * One radius scale, so "rounded" means the same thing everywhere. D5's 0.45rem
 * base is `md`; the others derive from it rather than being chosen ad hoc,
 * which is what keeps a dialog and a button visibly related.
 */
export const RADIUS = {
  none: '0',
  sm: '0.25rem',
  md: '0.45rem',
  lg: '0.7rem',
  full: '9999px',
} as const;

/**
 * A dense type scale. 13px body is the D5 decision: this is an operations tool
 * where seeing more at once beats comfortable reading length.
 */
export const TYPE_SCALE = {
  xs: '11px',
  sm: '12px',
  body: '13px',
  lg: '15px',
  xl: '18px',
  title: '22px',
} as const;

/** Every semantic token as flat `--dls-*` custom properties for one theme. */
export function cssVariables(theme: ThemeName): Record<string, string> {
  const t = THEMES[theme];
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(t.surface)) out[`--dls-surface-${key}`] = value;
  for (const [key, value] of Object.entries(t.text)) out[`--dls-text-${kebab(key)}`] = value;
  for (const [key, value] of Object.entries(t.border)) out[`--dls-border-${key}`] = value;
  for (const [key, value] of Object.entries(t.status)) out[`--dls-status-${key}`] = value;
  out['--dls-accent'] = t.accent;
  for (const [key, value] of Object.entries(RADIUS)) out[`--dls-radius-${key}`] = value;
  for (const [key, value] of Object.entries(TYPE_SCALE)) out[`--dls-text-size-${key}`] = value;
  return out;
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Render a theme as a CSS rule body, sorted so diffs stay readable. */
export function cssRule(theme: ThemeName, selector: string): string {
  const vars = cssVariables(theme);
  const lines = Object.keys(vars).sort().map((name) => `  ${name}: ${vars[name]};`);
  return `${selector} {\n${lines.join('\n')}\n}`;
}

/** Parse `#rrggbb` into channels. Throws rather than guessing on bad input. */
export function parseHex(hex: string): { r: number; g: number; b: number } {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Not a 6-digit hex colour: ${hex}`);
  const n = parseInt(match[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** WCAG relative luminance. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
