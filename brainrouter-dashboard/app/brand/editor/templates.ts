/** Editor doc factories: blank canvas, layer constructors, and seed templates. */

import type { EditorDoc, Layer, LayerType, TextLayer, ImageLayer, LogoLayer, ShapeLayer } from "./types";

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
  return { ...baseAt(Math.round(cx - 120), Math.round(cy - 80), 240, 160), type: "shape", name: "Shape", shape: "rect", fill: ACCENT, stroke: "none", strokeWidth: 0, radius: 16 } satisfies ShapeLayer;
}

function txt(o: Partial<TextLayer> & { x: number; y: number; w: number; text: string }): TextLayer {
  return { ...baseAt(o.x, o.y, o.w, o.fontSize ? Math.round(o.fontSize * 1.3) : 80), type: "text", name: o.name || "Text", text: o.text, fontFamily: o.fontFamily || "sans", fontSize: o.fontSize || 56, weight: o.weight ?? 600, color: o.color || "#ECEFF2", align: o.align || "left", letterSpacing: o.letterSpacing ?? -1, lineHeight: o.lineHeight ?? 1.1, effect: o.effect || "none", effectColor: o.effectColor || "#000000" };
}

export function releaseTemplate(): EditorDoc {
  const d = blankDoc(1200, 630);
  d.layers = [
    { ...baseAt(64, 52, 280, 58), type: "logo", name: "Logo", lockup: "full", color: ACCENT },
    txt({ x: 64, y: 222, w: 720, text: "RELEASE", fontSize: 22, weight: 600, color: ACCENT, fontFamily: "mono", letterSpacing: 3 }),
    txt({ x: 64, y: 248, w: 850, text: "Cognitive memory for autonomous AI agents.", fontSize: 60, weight: 600, color: "#ECEFF2", letterSpacing: -2 }),
    txt({ x: 64, y: 484, w: 820, text: "Short-term feeds long-term, unused facts fade, cited ones are reinforced.", fontSize: 26, weight: 400, color: "#9BA3AC", letterSpacing: 0 }),
    txt({ x: 64, y: 562, w: 400, text: "brainrouter.dev", fontSize: 21, weight: 500, color: "#5E6670", fontFamily: "mono" }),
  ];
  return d;
}

export function quoteTemplate(): EditorDoc {
  const d = blankDoc(1080, 1080);
  d.layers = [
    { ...baseAt(440, 96, 200, 52), type: "logo", name: "Logo", lockup: "mark", color: ACCENT },
    txt({ x: 120, y: 380, w: 840, text: "Your agent shouldn’t start from zero every morning.", fontSize: 76, weight: 600, color: "#ECEFF2", align: "center", letterSpacing: -2 }),
    txt({ x: 120, y: 940, w: 840, text: "BRAINROUTER · MEMORY-FIRST AI", fontSize: 24, weight: 600, color: ACCENT, align: "center", fontFamily: "mono", letterSpacing: 2 }),
  ];
  return d;
}

export const TEMPLATE_FACTORIES: { key: string; label: string; make: () => EditorDoc }[] = [
  { key: "release", label: "Release card", make: releaseTemplate },
  { key: "quote", label: "Quote", make: quoteTemplate },
  { key: "blank", label: "Blank", make: () => blankDoc(1200, 630) },
];
