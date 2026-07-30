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

/**
 * Per-platform "don't put anything important here" guides (all fractions of the
 * canvas W/H, so they scale with any matching size). `avatar` is the circle the
 * platform overlays the profile photo / logo into (covers whatever's under it);
 * `safe` is the area that survives device cropping (content outside may be cut).
 * Approximate + directional — exact pixels vary by platform/device. Editor-only,
 * never exported.
 */
export interface SafeZone {
  avatar?: { cx: number; cy: number; r: number };
  safe?: { x: number; y: number; w: number; h: number };
  note: string;
}
export const SAFE_ZONES: Record<string, SafeZone> = {
  x_header: { avatar: { cx: 0.06, cy: 1.0, r: 0.3 }, note: "Your avatar covers the lower-left." },
  linkedin_personal: { avatar: { cx: 0.085, cy: 1.0, r: 0.42 }, note: "Profile photo + name sit over the lower-left — keep key content right/centre." },
  linkedin_company: { avatar: { cx: 0.1, cy: 1.0, r: 0.62 }, note: "Company logo sits lower-left." },
  facebook_cover: { avatar: { cx: 0.06, cy: 1.0, r: 0.28 }, safe: { x: 0.1, y: 0.06, w: 0.8, h: 0.88 }, note: "Profile photo covers lower-left; sides crop on mobile." },
  youtube: { safe: { x: 0.198, y: 0.353, w: 0.604, h: 0.294 }, note: "Only the centre is visible on every device (TV/desktop/mobile)." },
  story: { safe: { x: 0.06, y: 0.14, w: 0.88, h: 0.72 }, note: "Top & bottom are covered by the app UI." },
};
/** Safe-zone for an exact W×H if it matches a known platform size, else null. */
export function safeZoneForSize(w: number, h: number): SafeZone | null {
  for (const k of Object.keys(SIZES)) if (SIZES[k].w === w && SIZES[k].h === h) return SAFE_ZONES[k] ?? null;
  return null;
}

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

/** Canonical flat export palette; Brand Studio templates consume these roles. */
export const BRAND_EXPORT_COLORS = Object.freeze({
  canvas: "#07070B",
  surface: "#0B0C12",
  overlay: "#12131B",
  text: "#FAFAFA",
  secondary: "#A1A1AA",
  muted: "#85858F",
  primary: "#D8DBE2",
  route: "#7C4DFF",
});

export const THEMES: Record<string, Theme> = {
  void: { label: "Graphite", bg: BRAND_EXPORT_COLORS.canvas, bg2: BRAND_EXPORT_COLORS.surface, text: BRAND_EXPORT_COLORS.text, sub: BRAND_EXPORT_COLORS.secondary, muted: BRAND_EXPORT_COLORS.muted, accent: BRAND_EXPORT_COLORS.primary, accentSoft: "rgba(216,219,226,0.10)", border: "rgba(255,255,255,0.10)" },
  signal: { label: "Slate", bg: "#0B0C12", bg2: "#12131B", text: "#FAFAFA", sub: "#A1A1AA", muted: "#85858F", accent: "#D8DBE2", accentSoft: "rgba(216,219,226,0.10)", border: "rgba(255,255,255,0.14)" },
  light: { label: "Paper", bg: "#FAFAFA", bg2: "#FFFFFF", text: "#16191C", sub: "#4B535B", muted: "#68717B", accent: "#20242A", accentSoft: "rgba(32,36,42,0.10)", border: "rgba(16,19,22,0.12)" },
};
export type ThemeKey = keyof typeof THEMES;

/** Accent override palette (defaults to the theme's own accent). */
export const ACCENTS: Record<string, { label: string; hex: string }> = {
  theme: { label: "Theme neutral", hex: "" },
  silver: { label: "Silver", hex: BRAND_EXPORT_COLORS.primary },
  graphite: { label: "Graphite", hex: "#34343D" },
  violet: { label: "Route violet", hex: BRAND_EXPORT_COLORS.route },
};
export type AccentKey = keyof typeof ACCENTS;

export const BACKGROUNDS = {
  rosette: "Route field",
  aura: "Soft field",
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

export const RINGS = { gradient: "Neutral ring", solid: "Solid ring", guilloche: "Route frame", duo: "Dual arc", thin: "Hairline" } as const;
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
  ring: "solid",
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

/** The logo remains vector-only; composed posters and avatars may be flattened. */
export function allowsRasterExport(mode: Mode): boolean {
  return mode !== "logo";
}
