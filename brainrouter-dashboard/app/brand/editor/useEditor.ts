"use client";

import { useCallback, useState } from "react";
import type { EditorDoc, Layer, Background, LayerType, ImageLayer } from "./types";
import { releaseTemplate, newLayer, uid } from "./templates";

export function useEditor() {
  const [doc, setDoc] = useState<EditorDoc>(() => releaseTemplate());
  const [selId, setSelId] = useState<string | null>(null);

  const update = useCallback((id: string, patch: Partial<Layer>) => {
    setDoc((d) => ({ ...d, layers: d.layers.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)) }));
  }, []);
  const updateDoc = useCallback((patch: Partial<EditorDoc>) => setDoc((d) => ({ ...d, ...patch })), []);
  const setBg = useCallback((patch: Partial<Background>) => setDoc((d) => ({ ...d, background: { ...d.background, ...patch } })), []);

  const add = useCallback((type: LayerType) => {
    setDoc((d) => {
      const l = newLayer(type, d);
      setSelId(l.id);
      return { ...d, layers: [...d.layers, l] };
    });
  }, []);
  const addImage = useCallback((src: string) => {
    setDoc((d) => {
      const l = { ...(newLayer("image", d) as ImageLayer), src };
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
      const copy = { ...l, id: uid(), x: l.x + 24, y: l.y + 24, name: l.name + " copy" } as Layer;
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
  const load = useCallback((nd: EditorDoc) => {
    setDoc(nd);
    setSelId(null);
  }, []);

  return { doc, selId, setSelId, update, updateDoc, setBg, add, addImage, remove, duplicate, reorder, load };
}
