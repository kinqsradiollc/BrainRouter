/**
 * Brand Studio — presets, themes, templates and the design config.
 *
 * Pure data + types (no React/Next) so the SVG builders can be exercised by a
 * headless render harness. Admin-only studio for on-brand assets: social
 * posters, platform banners (LinkedIn/Facebook/X/YouTube/GitHub), profile-
 * picture frames, and standalone logo exports.
 */

export type Mode = "canvas" | "avatar" | "logo";

export type SizeGroup = "Social" | "Banner";
export interface SizeDef {
  w: number;
  h: number;
  group: SizeGroup;
  label: string;
  note: string;
}

export const SIZES: Record<string, SizeDef> = {
  // Social posts
  og: { w: 1200, h: 630, group: "Social", label: "OG / link preview", note: "1200×630" },
  square: { w: 1080, h: 1080, group: "Social", label: "Square post", note: "1080×1080" },
  portrait: { w: 1080, h: 1350, group: "Social", label: "Portrait post", note: "1080×1350" },
  story: { w: 1080, h: 1920, group: "Social", label: "Story / Reel", note: "1080×1920" },
  // Platform banners / covers
  x_header: { w: 1500, h: 500, group: "Banner", label: "X / Twitter header", note: "1500×500" },
  linkedin_personal: { w: 1584, h: 396, group: "Banner", label: "LinkedIn cover", note: "1584×396" },
  linkedin_company: { w: 1128, h: 191, group: "Banner", label: "LinkedIn company", note: "1128×191" },
  facebook_cover: { w: 1640, h: 664, group: "Banner", label: "Facebook cover", note: "1640×664" },
  youtube: { w: 2560, h: 1440, group: "Banner", label: "YouTube channel art", note: "2560×1440" },
  github: { w: 1280, h: 640, group: "Banner", label: "GitHub social", note: "1280×640" },
};
export type PresetKey = keyof typeof SIZES;

export interface Theme {
  label: string;
  bg: string;
  bg2: string;
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

/** Accent override palette (defaults to the theme's own accent). */
export const ACCENTS: Record<string, { label: string; hex: string }> = {
  theme: { label: "Theme", hex: "" },
  signal: { label: "Signal", hex: "#34C28E" },
  amber: { label: "Amber", hex: "#E0A063" },
  iris: { label: "Iris", hex: "#7C8CF8" },
  rose: { label: "Rose", hex: "#E5675F" },
  gold: { label: "Gold", hex: "#D8B45A" },
};
export type AccentKey = keyof typeof ACCENTS;

export const BACKGROUNDS = {
  rosette: "Guilloché",
  aura: "Aura glow",
  grid: "Dot grid",
  gradient: "Gradient",
  solid: "Solid",
  transparent: "Transparent",
} as const;
export type BgKey = keyof typeof BACKGROUNDS;

export const TEMPLATES = {
  release: "Release",
  feature: "Feature",
  role: "Role card",
  quote: "Quote",
  minimal: "Logo lockup",
} as const;
export type TemplateKey = keyof typeof TEMPLATES;

export const LOCKUPS = { full: "Logo + name", mark: "Mark only", wordmark: "Name only" } as const;
export type LockupKey = keyof typeof LOCKUPS;

export const ROLES: Record<string, string> = {
  none: "None",
  founder: "Founder",
  cofounder: "Co-founder",
  founding_engineer: "Founding Engineer",
  core: "Core Team",
  engineer: "Engineer",
  designer: "Designer",
  advisor: "Advisor",
  investor: "Investor",
  ambassador: "Ambassador",
  partner: "Partner",
  contributor: "Contributor",
  verified: "Verified",
  early: "Early Adopter",
};
export type RoleKey = keyof typeof ROLES;

export const AVATAR_SHAPES = { circle: "Circle", rounded: "Rounded", square: "Square" } as const;
export type AvatarShape = keyof typeof AVATAR_SHAPES;

export const RINGS = { gradient: "Gradient ring", solid: "Solid ring", guilloche: "Guilloché ring", duo: "Dual arc", thin: "Hairline" } as const;
export type RingKey = keyof typeof RINGS;

export interface BrandConfig {
  mode: Mode;

  // poster
  preset: PresetKey;
  template: TemplateKey;
  align: "left" | "center";
  background: BgKey;
  eyebrow: string;
  headline: string;
  subhead: string;
  version: string;
  showVersion: boolean;
  lockup: LockupKey;
  role: RoleKey;

  // shared look
  theme: ThemeKey;
  accent: AccentKey;

  // avatar
  imageDataUrl: string | null;
  avatarShape: AvatarShape;
  ring: RingKey;
  ringWidth: number; // 1..10 (relative thickness)
  avatarTransparent: boolean;

  // logo export
  logoSize: number; // px (square mark / lockup height)
  logoTransparent: boolean;
}

export const DEFAULT_CONFIG: BrandConfig = {
  mode: "canvas",
  preset: "og",
  template: "release",
  align: "left",
  background: "rosette",
  eyebrow: "Release",
  headline: "Cognitive memory for autonomous AI agents.",
  subhead: "Short-term feeds long-term, unused facts fade, cited ones are reinforced — the same loop your mind runs.",
  version: "v0.4.9",
  showVersion: true,
  lockup: "full",
  role: "none",

  theme: "void",
  accent: "theme",

  imageDataUrl: null,
  avatarShape: "circle",
  ring: "gradient",
  ringWidth: 5,
  avatarTransparent: true,

  logoSize: 512,
  logoTransparent: true,
};

/** Resolve the effective accent (override or theme default). */
export function resolveAccent(cfg: BrandConfig): string {
  const a = ACCENTS[cfg.accent];
  return a && a.hex ? a.hex : THEMES[cfg.theme].accent;
}

/** Output dimensions for the current mode. */
export function dimsFor(cfg: BrandConfig): { w: number; h: number } {
  if (cfg.mode === "avatar") return { w: 1024, h: 1024 };
  if (cfg.mode === "logo") {
    const s = cfg.logoSize;
    if (cfg.lockup === "mark") return { w: s, h: s };
    if (cfg.lockup === "wordmark") return { w: Math.round(s * 3.4), h: Math.round(s * 0.9) };
    return { w: Math.round(s * 3.9), h: s }; // full lockup
  }
  return { w: SIZES[cfg.preset].w, h: SIZES[cfg.preset].h };
}
