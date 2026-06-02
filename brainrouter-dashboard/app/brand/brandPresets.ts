/**
 * Brand Studio — presets, themes, templates and the design config.
 *
 * Pure data + types (no React/Next imports) so the SVG poster builder can also
 * be exercised by a headless render harness. Admin-only studio for producing
 * on-brand social/marketing assets (see app/brand/page.tsx).
 */

export const SIZES = {
  og: { w: 1200, h: 630, label: "OG · link preview", note: "1200 × 630" },
  square: { w: 1080, h: 1080, label: "Social square", note: "1080 × 1080" },
  story: { w: 1080, h: 1920, label: "Story / Reel", note: "1080 × 1920" },
  header: { w: 1500, h: 500, label: "Header banner", note: "1500 × 500" },
  github: { w: 1280, h: 640, label: "GitHub social", note: "1280 × 640" },
} as const;
export type PresetKey = keyof typeof SIZES;

export interface Theme {
  label: string;
  bg: string;
  bg2: string; // gradient companion / panel
  text: string;
  sub: string;
  muted: string;
  accent: string;
  accentSoft: string;
  border: string;
}

export const THEMES: Record<string, Theme> = {
  void: { label: "Void", bg: "#0B0D0F", bg2: "#14171A", text: "#ECEFF2", sub: "#9BA3AC", muted: "#5E6670", accent: "#34C28E", accentSoft: "rgba(52,194,142,0.16)", border: "rgba(255,255,255,0.10)" },
  signal: { label: "Signal", bg: "#06120D", bg2: "#0B2018", text: "#ECFBF4", sub: "#8FC8B2", muted: "#5E8B79", accent: "#42D6A0", accentSoft: "rgba(66,214,160,0.22)", border: "rgba(66,214,160,0.20)" },
  light: { label: "Light", bg: "#FAFAFA", bg2: "#FFFFFF", text: "#15181B", sub: "#4B535B", muted: "#8A929B", accent: "#1E9E73", accentSoft: "rgba(30,158,115,0.12)", border: "rgba(16,19,22,0.12)" },
};
export type ThemeKey = keyof typeof THEMES;

export const BACKGROUNDS = {
  rosette: "Guilloché",
  aura: "Aura glow",
  grid: "Dot grid",
  gradient: "Gradient",
  solid: "Solid",
} as const;
export type BgKey = keyof typeof BACKGROUNDS;

export const TEMPLATES = {
  release: "Release",
  feature: "Feature",
  quote: "Quote",
  minimal: "Logo lockup",
} as const;
export type TemplateKey = keyof typeof TEMPLATES;

export interface BrandConfig {
  preset: PresetKey;
  template: TemplateKey;
  theme: ThemeKey;
  background: BgKey;
  eyebrow: string;
  headline: string;
  subhead: string;
  version: string;
  showVersion: boolean;
  showLogo: boolean;
}

export const DEFAULT_CONFIG: BrandConfig = {
  preset: "og",
  template: "release",
  theme: "void",
  background: "rosette",
  eyebrow: "Release",
  headline: "Cognitive memory for autonomous AI agents.",
  subhead: "Short-term feeds long-term, unused facts fade, cited ones are reinforced — the same loop your mind runs.",
  version: "v0.4.9",
  showVersion: true,
  showLogo: true,
};
