"use client";

import { useCallback, useState } from "react";
import type { EditorDoc, Layer, Background, LayerType, ImageLayer } from "./types";
import { releaseTemplate, newLayer, uid } from "./templates";
import { normalizeLayer } from "./measure";

/** Apply a single uniform scale + translation to every layer (positions, sizes,
 *  font size, radii, strokes all scale by the same factor → never distorted).
 *  Each result is normalized so its box matches what renders. */
function transformLayers(layers: Layer[], s: number, offX: number, offY: number): Layer[] {
  return layers.map((l) => {
    const b = { x: Math.round(l.x * s + offX), y: Math.round(l.y * s + offY), w: Math.max(8, Math.round(l.w * s)), h: Math.max(8, Math.round(l.h * s)) };
    let scaled: Layer;
    if (l.type === "text") scaled = { ...l, ...b, fontSize: Math.max(6, Math.round(l.fontSize * s)) };
    else if (l.type === "image") scaled = { ...l, ...b, radius: Math.round(l.radius * s) };
    else if (l.type === "shape") scaled = { ...l, ...b, radius: Math.round(l.radius * s), strokeWidth: Math.max(0, Math.round(l.strokeWidth * s)) };
    else scaled = { ...l, ...b };
    return normalizeLayer(scaled);
  });
}

export function useEditor() {
  const [doc, setDoc] = useState<EditorDoc>(() => {
    const d = releaseTemplate();
    return { ...d, layers: d.layers.map(normalizeLayer) };
  });
  const [selId, setSelId] = useState<string | null>(null);

  const update = useCallback((id: string, patch: Partial<Layer>) => {
    setDoc((d) => ({ ...d, layers: d.layers.map((l) => (l.id === id ? normalizeLayer({ ...l, ...patch } as Layer) : l)) }));
  }, []);
  const updateDoc = useCallback((patch: Partial<EditorDoc>) => setDoc((d) => ({ ...d, ...patch })), []);
  const setBg = useCallback((patch: Partial<Background>) => setDoc((d) => ({ ...d, background: { ...d.background, ...patch } })), []);

  const add = useCallback((type: LayerType) => {
    setDoc((d) => {
      const l = normalizeLayer(newLayer(type, d));
      setSelId(l.id);
      return { ...d, layers: [...d.layers, l] };
    });
  }, []);
  const addImage = useCallback((src: string) => {
    setDoc((d) => {
      const l = normalizeLayer({ ...(newLayer("image", d) as ImageLayer), src });
      setSelId(l.id);
      return { ...d, layers: [...d.layers, l] };
    });
  }, []);
  const remove = useCallback((id: string) => {
    setDoc((d) => ({ ...d, layers: d.layers.filter((l) => l.id !== id) }));
    setSelId((s) => (s === id ? null : s));
  }, []);
  const duplicate = useCallback((id: string) => {
    setDoc((d) => {
      const l = d.layers.find((x) => x.id === id);
      if (!l) return d;
      const copy = normalizeLayer({ ...l, id: uid(), x: l.x + 24, y: l.y + 24, name: l.name + " copy" } as Layer);
      setSelId(copy.id);
      return { ...d, layers: [...d.layers, copy] };
    });
  }, []);
  const reorder = useCallback((id: string, dir: "up" | "down") => {
    setDoc((d) => {
      const i = d.layers.findIndex((l) => l.id === id);
      if (i < 0) return d;
      const j = dir === "up" ? i + 1 : i - 1;
      if (j < 0 || j >= d.layers.length) return d;
      const a = [...d.layers];
      [a[i], a[j]] = [a[j], a[i]];
      return { ...d, layers: a };
    });
  }, []);
  const setCanvasSize = useCallback((w: number, h: number) => {
    setDoc((d) => {
      if (w < 8 || h < 8 || (w === d.width && h === d.height)) return { ...d, width: w, height: h };
      // Uniform scale about the centre so the design fits the new frame without
      // distortion and stays centred — the predictable "resize the poster" move.
      const s = Math.min(w / d.width, h / d.height);
      return { ...d, width: w, height: h, layers: transformLayers(d.layers, s, (w - d.width * s) / 2, (h - d.height * s) / 2) };
    });
  }, []);
  const loadTemplate = useCallback((make: () => EditorDoc) => {
    // Adopt the template's native canvas + layout verbatim (just normalized) so
    // each poster renders exactly as designed rather than squished into the
    // current aspect ratio. Resize afterwards if a different format is needed.
    const t = make();
    setDoc({ width: t.width, height: t.height, background: { ...t.background }, layers: t.layers.map(normalizeLayer) });
    setSelId(null);
  }, []);

  /** Uniformly scale + centre every visible layer to fit ~88% of the frame.
   *  The one-click tidy after resizing the canvas or moving things around. */
  const fitContent = useCallback(() => {
    setDoc((d) => {
      const ls = d.layers.filter((l) => l.visible);
      if (!ls.length) return d;
      const minX = Math.min(...ls.map((l) => l.x));
      const minY = Math.min(...ls.map((l) => l.y));
      const maxX = Math.max(...ls.map((l) => l.x + l.w));
      const maxY = Math.max(...ls.map((l) => l.y + l.h));
      const bw = Math.max(1, maxX - minX);
      const bh = Math.max(1, maxY - minY);
      const s = Math.min((d.width * 0.88) / bw, (d.height * 0.88) / bh);
      const offX = (d.width - bw * s) / 2 - minX * s;
      const offY = (d.height - bh * s) / 2 - minY * s;
      return { ...d, layers: transformLayers(d.layers, s, offX, offY) };
    });
  }, []);

  return { doc, selId, setSelId, update, updateDoc, setBg, add, addImage, remove, duplicate, reorder, setCanvasSize, loadTemplate, fitContent };
}
