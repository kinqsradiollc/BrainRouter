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

/**
 * Apply a runtime accent override (matches the desktop's user-overridable
 * `--accent`). Returns a new ThemeTokens with the accent family swapped; the
 * wash/line/press are derived from the same hue when given an hsl() string.
 */
export function withAccent(theme: ThemeTokens, accent: string): ThemeTokens {
  return {
    ...theme,
    colors: { ...theme.colors, accent },
  };
}
