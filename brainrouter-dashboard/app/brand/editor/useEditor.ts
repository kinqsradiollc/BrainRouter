"use client";

import { useCallback, useState } from "react";
import type { EditorDoc, Layer, Background, LayerType, ImageLayer } from "./types";
import { releaseTemplate, newLayer, uid } from "./templates";
import { normalizeLayer } from "./measure";

/** Scale all layers proportionally — positions per-axis, sizes uniformly — so
 *  resizing the canvas or applying a template keeps the layout intact. Each
 *  result is normalized so its box matches what renders. */
function rescaleLayers(layers: Layer[], sx: number, sy: number): Layer[] {
  const fs = Math.min(sx, sy);
  return layers.map((l) => {
    if (sx === 1 && sy === 1) return normalizeLayer(l);
    const b = { x: Math.round(l.x * sx), y: Math.round(l.y * sy), w: Math.max(8, Math.round(l.w * sx)), h: Math.max(8, Math.round(l.h * sy)) };
    let scaled: Layer;
    if (l.type === "text") scaled = { ...l, ...b, fontSize: Math.max(6, Math.round(l.fontSize * fs)) };
    else if (l.type === "image") scaled = { ...l, ...b, radius: Math.round(l.radius * fs) };
    else if (l.type === "shape") scaled = { ...l, ...b, radius: Math.round(l.radius * fs), strokeWidth: Math.round(l.strokeWidth * fs) };
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
    setDoc((d) => (w < 8 || h < 8 || (w === d.width && h === d.height) ? { ...d, width: w, height: h } : { ...d, width: w, height: h, layers: rescaleLayers(d.layers, w / d.width, h / d.height) }));
  }, []);
  const loadTemplate = useCallback((make: () => EditorDoc) => {
    setDoc((d) => {
      const t = make();
      return { ...d, background: { ...t.background }, layers: rescaleLayers(t.layers, d.width / t.width, d.height / t.height) };
    });
    setSelId(null);
  }, []);

  return { doc, selId, setSelId, update, updateDoc, setBg, add, addImage, remove, duplicate, reorder, setCanvasSize, loadTemplate };
}
