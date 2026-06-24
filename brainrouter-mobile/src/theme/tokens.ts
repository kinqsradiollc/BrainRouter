/**
 * Design tokens — ported 1:1 from `prototypes/global.css` (the prototype source
 * of truth) and `docs/design/DESIGN-expo.md`. The active accent matches the
 * desktop app: indigo/purple `hsl(245 80% 66%)`.
 *
 * Pure data module (no React Native imports) so it is testable/typecheckable
 * without native deps; `ThemeProvider.tsx` consumes it. Colors are expressed in
 * the comma-form `hsl()/hsla()`/hex that React Native's color parser accepts.
 */

export type ThemeName = 'dark' | 'light';

export interface ColorTokens {
  /** Page canvas (never pure black). */
  base: string;
  /** Panels, cards, tab bar. */
  raised: string;
  /** Sheets, menus, active rows. */
  overlay: string;
  border: string;
  borderStrong: string;
  /** Primary text (never pure white). */
  text: string;
  /** Secondary text, labels. */
  text2: string;
  /** Metadata, placeholders, disabled. */
  muted: string;
  /** Single chromatic accent (desktop indigo/purple). */
  accent: string;
  accentPress: string;
  /** Active-row tint / selected halo. */
  accentWash: string;
  /** Accent hairline borders. */
  accentLine: string;
  /** Text/icon on an accent fill. */
  accentText: string;
  /** Recall Heat — DATA ENCODING ONLY (graph/timeline legend), never chrome. */
  heatHot: string;
  heatWarm: string;
  heatCool: string;
  heatCold: string;
  /** Contradiction, destructive, error. */
  danger: string;
  /** Stale-vs-code, caution. */
  warn: string;
}

export interface RadiusTokens {
  chip: number;
  control: number;
  card: number;
  panel: number;
}

export interface SpacingScale {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  xxl: number;
}

export interface TypeTokens {
  /** Sans family stack (Geist primary). */
  font: string;
  /** Monospace family stack (Geist Mono primary). */
  mono: string;
}

export interface ThemeTokens {
  name: ThemeName;
  colors: ColorTokens;
  radius: RadiusTokens;
  spacing: SpacingScale;
  type: TypeTokens;
}

const RADIUS: RadiusTokens = { chip: 4, control: 6, card: 10, panel: 12 };

// 4pt base spacing scale (DESIGN-expo.md).
const SPACING: SpacingScale = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

const TYPE: TypeTokens = {
  font: 'Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  mono: 'Geist Mono, ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace',
};

const DARK_COLORS: ColorTokens = {
  base: '#0B0D0F',
  raised: '#14171A',
  overlay: '#1E2227',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.14)',
  text: '#ECEFF2',
  text2: '#9BA3AC',
  muted: '#5E6670',
  accent: 'hsl(245, 80%, 66%)',
  accentPress: 'hsl(245, 80%, 60%)',
  accentWash: 'hsla(245, 80%, 66%, 0.14)',
  accentLine: 'hsla(245, 80%, 66%, 0.40)',
  accentText: '#ffffff',
  heatHot: '#E0A063',
  heatWarm: '#C98F6E',
  heatCool: '#6B7480',
  heatCold: '#3C434B',
  danger: '#E5675F',
  warn: '#D9A441',
};

const LIGHT_COLORS: ColorTokens = {
  base: '#FAFAFA',
  raised: '#FFFFFF',
  overlay: '#F3F4F6',
  border: 'rgba(16,19,22,0.10)',
  borderStrong: 'rgba(16,19,22,0.18)',
  text: '#16191C',
  text2: '#4B535B',
  muted: '#8A929B',
  accent: 'hsl(245, 58%, 56%)',
  accentPress: 'hsl(245, 58%, 50%)',
  accentWash: 'hsla(245, 58%, 56%, 0.12)',
  accentLine: 'hsla(245, 58%, 56%, 0.40)',
  accentText: '#ffffff',
  heatHot: '#E0A063',
  heatWarm: '#C98F6E',
  heatCool: '#6B7480',
  heatCold: '#3C434B',
  danger: '#E5675F',
  warn: '#D9A441',
};

export const darkTheme: ThemeTokens = {
  name: 'dark',
  colors: DARK_COLORS,
  radius: RADIUS,
  spacing: SPACING,
  type: TYPE,
};

export const lightTheme: ThemeTokens = {
  name: 'light',
  colors: LIGHT_COLORS,
  radius: RADIUS,
  spacing: SPACING,
  type: TYPE,
};

export const themes: Record<ThemeName, ThemeTokens> = {
  dark: darkTheme,
  light: lightTheme,
};

/** Default theme — dark, matching the desktop app's default. */
export const defaultTheme = darkTheme;

/** Parse a `#rgb`/`#rrggbb` or `hsl(h, s%, l%)` color to 0–255 RGB; null if neither. */
function toRgb(color: string): { r: number; g: number; b: number } | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  const hsl = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i.exec(color.trim());
  if (hsl) return hslToRgb(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100);
  return null;
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hn = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return { r: Math.round(channel(hn + 1 / 3) * 255), g: Math.round(channel(hn) * 255), b: Math.round(channel(hn - 1 / 3) * 255) };
}

/**
 * Apply a runtime accent override (matches the desktop's user-overridable
 * `--accent`). Returns a new ThemeTokens with the accent swapped AND the
 * wash / line / press DERIVED from the same color, so selected-row tints,
 * hairline borders, and pressed states track the accent — not just primary
 * fills. Falls back to leaving the derived tokens unchanged if the color string
 * can't be parsed.
 */
export function withAccent(theme: ThemeTokens, accent: string): ThemeTokens {
  const rgb = toRgb(accent);
  if (!rgb) return { ...theme, colors: { ...theme.colors, accent } };
  const { r, g, b } = rgb;
  return {
    ...theme,
    colors: {
      ...theme.colors,
      accent,
      accentWash: `rgba(${r}, ${g}, ${b}, 0.14)`,
      accentLine: `rgba(${r}, ${g}, ${b}, 0.40)`,
      accentPress: `rgb(${Math.round(r * 0.86)}, ${Math.round(g * 0.86)}, ${Math.round(b * 0.86)})`,
    },
  };
}
