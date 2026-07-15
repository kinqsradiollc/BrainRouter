/** Editor doc factories: blank canvas, layer constructors, and seed templates. */

import type { EditorDoc, Layer, LayerType, TextLayer, ImageLayer, LogoLayer, ShapeLayer, BadgeLayer } from "./types";
import { badgeWidth } from "./measure";
import { BRAND_EXPORT_COLORS as C } from "../brandPresets";

let _c = 0;
export function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    _c += 1;
    return `id-${_c}-${Math.floor((typeof performance !== "undefined" ? performance.now() : _c) % 1e6)}`;
  }
}

const ACCENT = C.primary;

export function blankDoc(w = 1200, h = 630): EditorDoc {
  return {
    width: w,
    height: h,
    background: { type: "rosette", color: C.canvas, from: C.overlay, to: C.canvas, angle: 135, accent: ACCENT, src: null },
    layers: [],
  };
}

function baseAt(x: number, y: number, w: number, h: number) {
  return { id: uid(), x, y, w, h, rotation: 0, opacity: 1, visible: true, locked: false };
}

export function newLayer(type: LayerType, doc: EditorDoc): Layer {
  const cx = doc.width / 2;
  const cy = doc.height / 2;
  if (type === "text") {
    return { ...baseAt(Math.round(cx - 220), Math.round(cy - 40), 440, 90), type: "text", name: "Text", text: "Your text", fontFamily: "sans", fontSize: 64, weight: 600, color: C.text, align: "left", letterSpacing: -1, lineHeight: 1.1, effect: "none", effectColor: C.canvas } satisfies TextLayer;
  }
  if (type === "image") {
    return { ...baseAt(Math.round(cx - 180), Math.round(cy - 180), 360, 360), type: "image", name: "Image", src: "", radius: 24 } satisfies ImageLayer;
  }
  if (type === "logo") {
    return { ...baseAt(Math.round(cx - 140), Math.round(cy - 36), 280, 72), type: "logo", name: "Logo", lockup: "full", color: ACCENT } satisfies LogoLayer;
  }
  if (type === "badge") {
    return { ...baseAt(Math.round(cx - 120), Math.round(cy - 43), 240, 86), type: "badge", name: "Badge", label: "FOUNDER", roleKey: "founder", style: "solid", color: ACCENT } satisfies BadgeLayer;
  }
  return { ...baseAt(Math.round(cx - 120), Math.round(cy - 80), 240, 160), type: "shape", name: "Shape", shape: "rect", fill: ACCENT, stroke: "none", strokeWidth: 0, radius: 16 } satisfies ShapeLayer;
}

function txt(o: Partial<TextLayer> & { x: number; y: number; w: number; text: string }): TextLayer {
  return { ...baseAt(o.x, o.y, o.w, o.fontSize ? Math.round(o.fontSize * 1.3) : 80), type: "text", name: o.name || "Text", text: o.text, fontFamily: o.fontFamily || "sans", fontSize: o.fontSize || 56, weight: o.weight ?? 600, color: o.color || C.text, align: o.align || "left", letterSpacing: o.letterSpacing ?? -1, lineHeight: o.lineHeight ?? 1.1, effect: o.effect || "none", effectColor: o.effectColor || C.canvas };
}

/** Role badge pill. Pass `cx` to centre, `x2` to right-align (width is content-derived). */
function badge(o: { y: number; h: number; label: string; roleKey: string; cx?: number; x?: number; x2?: number; style?: "glass" | "solid"; color?: string }): BadgeLayer {
  const tmp: BadgeLayer = { ...baseAt(0, o.y, 0, o.h), type: "badge", name: "Badge", label: o.label, roleKey: o.roleKey, style: o.style || "solid", color: o.color || ACCENT };
  const w = badgeWidth(tmp);
  const x = o.x2 != null ? Math.round(o.x2 - w) : o.cx != null ? Math.round(o.cx - w / 2) : o.x ?? 0;
  return { ...tmp, x, w };
}

export function releaseTemplate(): EditorDoc {
  const d = blankDoc(1200, 630);
  d.layers = [
    { ...baseAt(64, 52, 280, 58), type: "logo", name: "Logo", lockup: "full", color: ACCENT },
    txt({ x: 64, y: 222, w: 720, text: "RELEASE", fontSize: 22, weight: 600, color: ACCENT, fontFamily: "mono", letterSpacing: 3 }),
    txt({ x: 64, y: 248, w: 850, text: "Route agent work with\npolicy and evidence.", fontSize: 60, weight: 600, color: C.text, letterSpacing: -2 }),
    txt({ x: 64, y: 488, w: 820, text: "Build, plan, connect, remember, and review\nfrom one operations workspace.", fontSize: 26, weight: 400, color: C.secondary, letterSpacing: 0 }),
    txt({ x: 64, y: 562, w: 400, text: "brainrouter.dev", fontSize: 21, weight: 500, color: C.muted, fontFamily: "mono" }),
  ];
  return d;
}

export function quoteTemplate(): EditorDoc {
  const d = blankDoc(1080, 1080);
  d.layers = [
    { ...baseAt(440, 96, 200, 52), type: "logo", name: "Logo", lockup: "mark", color: ACCENT },
    txt({ x: 120, y: 380, w: 840, text: "Route the right model,\ncontext, and reviewer.", fontSize: 76, weight: 600, color: C.text, align: "center", letterSpacing: -2 }),
    txt({ x: 120, y: 940, w: 840, text: "BRAINROUTER · AGENT OPERATIONS", fontSize: 24, weight: 600, color: ACCENT, align: "center", fontFamily: "mono", letterSpacing: 2 }),
  ];
  return d;
}

export function roleCardTemplate(): EditorDoc {
  const d = blankDoc(1080, 1350);
  const cx = 540;
  d.layers = [
    { ...baseAt(cx - 54, 150, 108, 108), type: "logo", name: "Logo", lockup: "mark", color: ACCENT },
    badge({ cx, y: 300, h: 92, label: "FOUNDER", roleKey: "founder", style: "solid" }),
    txt({ x: 100, y: 470, w: 880, text: "Your Name", fontSize: 96, weight: 600, color: C.text, align: "center", letterSpacing: -2 }),
    txt({ x: 120, y: 624, w: 840, text: "Founding Engineer · BrainRouter", fontSize: 34, weight: 400, color: C.secondary, align: "center", letterSpacing: 0 }),
    txt({ x: 120, y: 1252, w: 840, text: "brainrouter.dev", fontSize: 26, weight: 500, color: C.muted, align: "center", fontFamily: "mono" }),
  ];
  return d;
}

/** Landscape role card for LinkedIn / Facebook / X covers. Horizontal layout:
 *  brand mark top-left, identity block on the right — deliberately keeping the
 *  lower-left clear, where the platform overlays the profile photo. */
export function roleBannerTemplate(): EditorDoc {
  const d = blankDoc(1584, 396); // LinkedIn cover; maps cleanly to other banners
  // Keep the identity block right-aligned and the lower-left safe zone quiet.
  d.background = { type: "solid", color: C.canvas, from: C.overlay, to: C.canvas, angle: 8, accent: ACCENT, src: null };
  const R = 1512; // shared right edge for the block
  d.layers = [
    { ...baseAt(1263, 50, 249, 44), type: "logo", name: "Logo", lockup: "full", color: ACCENT },
    badge({ x2: R, y: 124, h: 66, label: "FOUNDER", roleKey: "founder", style: "solid" }),
    txt({ x: 412, y: 198, w: 1100, text: "Your Name", fontSize: 82, weight: 600, color: C.text, align: "right", letterSpacing: -2 }),
    txt({ x: 512, y: 298, w: 1000, text: "Founding Engineer · BrainRouter", fontSize: 28, weight: 400, color: C.secondary, align: "right" }),
    txt({ x: 812, y: 348, w: 700, text: "brainrouter.dev", fontSize: 21, weight: 500, color: C.muted, fontFamily: "mono", align: "right" }),
  ];
  return d;
}

export function featureTemplate(): EditorDoc {
  const d = blankDoc(1200, 630);
  d.layers = [
    { ...baseAt(64, 52, 280, 58), type: "logo", name: "Logo", lockup: "full", color: ACCENT },
    txt({ x: 64, y: 222, w: 720, text: "FEATURE", fontSize: 22, weight: 600, color: ACCENT, fontFamily: "mono", letterSpacing: 3 }),
    txt({ x: 64, y: 248, w: 940, text: "Review every change with\nrepository-aware policy.", fontSize: 56, weight: 600, color: C.text, letterSpacing: -2 }),
    txt({ x: 64, y: 500, w: 900, text: "Code and security review stay explicit, scoped, and traceable.", fontSize: 25, weight: 400, color: C.secondary }),
    txt({ x: 64, y: 562, w: 400, text: "brainrouter.dev", fontSize: 21, weight: 500, color: C.muted, fontFamily: "mono" }),
  ];
  return d;
}

export function lockupTemplate(): EditorDoc {
  const d = blankDoc(1200, 630);
  d.layers = [
    { ...baseAt(328, 252, 543, 96), type: "logo", name: "Logo", lockup: "full", color: ACCENT },
    txt({ x: 200, y: 392, w: 800, text: "AGENT OPERATIONS", fontSize: 26, weight: 500, color: C.secondary, align: "center", letterSpacing: 4, fontFamily: "mono" }),
  ];
  return d;
}

export const TEMPLATE_FACTORIES: { key: string; label: string; make: () => EditorDoc }[] = [
  { key: "release", label: "Release card", make: releaseTemplate },
  { key: "feature", label: "Feature card", make: featureTemplate },
  { key: "role", label: "Role card (portrait)", make: roleCardTemplate },
  { key: "roleBanner", label: "Role banner (wide)", make: roleBannerTemplate },
  { key: "quote", label: "Quote", make: quoteTemplate },
  { key: "lockup", label: "Logo lockup", make: lockupTemplate },
  { key: "blank", label: "Blank", make: () => blankDoc(1200, 630) },
];
