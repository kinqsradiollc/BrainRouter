/** Editor doc factories: blank canvas, layer constructors, and seed templates. */

import type { EditorDoc, Layer, LayerType, TextLayer, ImageLayer, LogoLayer, ShapeLayer, BadgeLayer } from "./types";
import { badgeWidth } from "./measure";

let _c = 0;
export function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    _c += 1;
    return `id-${_c}-${Math.floor((typeof performance !== "undefined" ? performance.now() : _c) % 1e6)}`;
  }
}

const ACCENT = "#34C28E";

export function blankDoc(w = 1200, h = 630): EditorDoc {
  return {
    width: w,
    height: h,
    background: { type: "rosette", color: "#0B0D0F", from: "#14171A", to: "#0B0D0F", angle: 135, accent: ACCENT, src: null },
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
    return { ...baseAt(Math.round(cx - 220), Math.round(cy - 40), 440, 90), type: "text", name: "Text", text: "Your text", fontFamily: "sans", fontSize: 64, weight: 600, color: "#ECEFF2", align: "left", letterSpacing: -1, lineHeight: 1.1, effect: "none", effectColor: "#000000" } satisfies TextLayer;
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
  return { ...baseAt(o.x, o.y, o.w, o.fontSize ? Math.round(o.fontSize * 1.3) : 80), type: "text", name: o.name || "Text", text: o.text, fontFamily: o.fontFamily || "sans", fontSize: o.fontSize || 56, weight: o.weight ?? 600, color: o.color || "#ECEFF2", align: o.align || "left", letterSpacing: o.letterSpacing ?? -1, lineHeight: o.lineHeight ?? 1.1, effect: o.effect || "none", effectColor: o.effectColor || "#000000" };
}

/** Role badge pill. Pass `cx` to centre it horizontally (width is content-derived). */
function badge(o: { y: number; h: number; label: string; roleKey: string; cx?: number; x?: number; style?: "glass" | "solid"; color?: string }): BadgeLayer {
  const tmp: BadgeLayer = { ...baseAt(0, o.y, 0, o.h), type: "badge", name: "Badge", label: o.label, roleKey: o.roleKey, style: o.style || "solid", color: o.color || ACCENT };
  const w = badgeWidth(tmp);
  const x = o.cx != null ? Math.round(o.cx - w / 2) : o.x ?? 0;
  return { ...tmp, x, w };
}

export function releaseTemplate(): EditorDoc {
  const d = blankDoc(1200, 630);
  d.layers = [
    { ...baseAt(64, 52, 280, 58), type: "logo", name: "Logo", lockup: "full", color: ACCENT },
    txt({ x: 64, y: 222, w: 720, text: "RELEASE", fontSize: 22, weight: 600, color: ACCENT, fontFamily: "mono", letterSpacing: 3 }),
    txt({ x: 64, y: 248, w: 850, text: "Cognitive memory for\nautonomous AI agents.", fontSize: 60, weight: 600, color: "#ECEFF2", letterSpacing: -2 }),
    txt({ x: 64, y: 488, w: 820, text: "Short-term feeds long-term, unused facts fade,\ncited ones are reinforced.", fontSize: 26, weight: 400, color: "#9BA3AC", letterSpacing: 0 }),
    txt({ x: 64, y: 562, w: 400, text: "brainrouter.dev", fontSize: 21, weight: 500, color: "#5E6670", fontFamily: "mono" }),
  ];
  return d;
}

export function quoteTemplate(): EditorDoc {
  const d = blankDoc(1080, 1080);
  d.layers = [
    { ...baseAt(440, 96, 200, 52), type: "logo", name: "Logo", lockup: "mark", color: ACCENT },
    txt({ x: 120, y: 380, w: 840, text: "Your agent shouldn’t start\nfrom zero every morning.", fontSize: 76, weight: 600, color: "#ECEFF2", align: "center", letterSpacing: -2 }),
    txt({ x: 120, y: 940, w: 840, text: "BRAINROUTER · MEMORY-FIRST AI", fontSize: 24, weight: 600, color: ACCENT, align: "center", fontFamily: "mono", letterSpacing: 2 }),
  ];
  return d;
}

export function roleCardTemplate(): EditorDoc {
  const d = blankDoc(1080, 1350);
  const cx = 540;
  d.layers = [
    { ...baseAt(cx - 54, 150, 108, 108), type: "logo", name: "Logo", lockup: "mark", color: ACCENT },
    badge({ cx, y: 300, h: 92, label: "FOUNDER", roleKey: "founder", style: "solid" }),
    txt({ x: 100, y: 470, w: 880, text: "Your Name", fontSize: 96, weight: 600, color: "#ECEFF2", align: "center", letterSpacing: -2 }),
    txt({ x: 120, y: 624, w: 840, text: "Founding Engineer · BrainRouter", fontSize: 34, weight: 400, color: "#9BA3AC", align: "center", letterSpacing: 0 }),
    txt({ x: 120, y: 1252, w: 840, text: "brainrouter.dev", fontSize: 26, weight: 500, color: "#5E6670", align: "center", fontFamily: "mono" }),
  ];
  return d;
}

/** Landscape role card for LinkedIn / Facebook / X covers. Horizontal layout:
 *  brand mark top-left, identity block on the right — deliberately keeping the
 *  lower-left clear, where the platform overlays the profile photo. */
export function roleBannerTemplate(): EditorDoc {
  const d = blankDoc(1584, 396); // LinkedIn cover; maps cleanly to other banners
  d.layers = [
    { ...baseAt(72, 50, 430, 44), type: "logo", name: "Logo", lockup: "full", color: ACCENT },
    badge({ x: 386, y: 126, h: 66, label: "FOUNDER", roleKey: "founder", style: "solid" }),
    txt({ x: 386, y: 200, w: 1100, text: "Your Name", fontSize: 82, weight: 600, color: "#ECEFF2", letterSpacing: -2 }),
    txt({ x: 388, y: 298, w: 1100, text: "Founding Engineer · BrainRouter", fontSize: 28, weight: 400, color: "#9BA3AC" }),
    txt({ x: 388, y: 348, w: 800, text: "brainrouter.dev", fontSize: 21, weight: 500, color: "#5E6670", fontFamily: "mono" }),
  ];
  return d;
}

export function featureTemplate(): EditorDoc {
  const d = blankDoc(1200, 630);
  d.layers = [
    { ...baseAt(64, 52, 280, 58), type: "logo", name: "Logo", lockup: "full", color: ACCENT },
    txt({ x: 64, y: 222, w: 720, text: "FEATURE", fontSize: 22, weight: 600, color: ACCENT, fontFamily: "mono", letterSpacing: 3 }),
    txt({ x: 64, y: 248, w: 940, text: "Recall that ranks itself —\nretrieve, rerank, judge, expand.", fontSize: 56, weight: 600, color: "#ECEFF2", letterSpacing: -2 }),
    txt({ x: 64, y: 500, w: 900, text: "A four-stage pipeline so agents read only what matters.", fontSize: 25, weight: 400, color: "#9BA3AC" }),
    txt({ x: 64, y: 562, w: 400, text: "brainrouter.dev", fontSize: 21, weight: 500, color: "#5E6670", fontFamily: "mono" }),
  ];
  return d;
}

export function lockupTemplate(): EditorDoc {
  const d = blankDoc(1200, 630);
  d.layers = [
    { ...baseAt(328, 252, 543, 96), type: "logo", name: "Logo", lockup: "full", color: ACCENT },
    txt({ x: 200, y: 392, w: 800, text: "MEMORY-FIRST AI", fontSize: 26, weight: 500, color: "#9BA3AC", align: "center", letterSpacing: 4, fontFamily: "mono" }),
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
