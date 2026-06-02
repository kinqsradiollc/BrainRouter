"use client";

import { useRef, useState } from "react";
import type { EditorDoc, Layer } from "./types";
import { buildEditorSVG } from "./buildEditorSVG";

const HANDLES = ["nw", "ne", "sw", "se"] as const;
type Handle = (typeof HANDLES)[number];
type Drag = { mode: "move" | Handle; id: string; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number; ofs: number };

export function EditorCanvas({
  doc,
  selId,
  onSelect,
  onChange,
  guides,
  maxW = 860,
  maxH = 560,
}: {
  doc: EditorDoc;
  selId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<Layer>) => void;
  guides: boolean;
  maxW?: number;
  maxH?: number;
}) {
  const drag = useRef<Drag | null>(null);
  const [snap, setSnap] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const [editingId, setEditingId] = useState<string | null>(null);
  const sc = Math.min(maxW / doc.width, maxH / doc.height, 1);
  const dispW = doc.width * sc;
  const dispH = doc.height * sc;
  const svg = buildEditorSVG(doc, { hideId: editingId ?? undefined }).replace("<svg ", '<svg style="display:block;width:100%;height:100%" ');
  const editing = editingId ? doc.layers.find((l) => l.id === editingId) : null;

  const startMove = (e: React.PointerEvent, l: Layer) => {
    if (l.locked) return;
    e.stopPropagation();
    onSelect(l.id);
    drag.current = { mode: "move", id: l.id, sx: e.clientX, sy: e.clientY, ox: l.x, oy: l.y, ow: l.w, oh: l.h, ofs: l.type === "text" ? l.fontSize : 0 };
  };
  const startResize = (e: React.PointerEvent, l: Layer, hd: Handle) => {
    e.stopPropagation();
    drag.current = { mode: hd, id: l.id, sx: e.clientX, sy: e.clientY, ox: l.x, oy: l.y, ow: l.w, oh: l.h, ofs: l.type === "text" ? l.fontSize : 0 };
  };

  const onMove = (e: React.PointerEvent) => {
    const dr = drag.current;
    if (!dr) return;
    const dx = (e.clientX - dr.sx) / sc;
    const dy = (e.clientY - dr.sy) / sc;
    const l = doc.layers.find((x) => x.id === dr.id);
    if (!l) return;

    if (dr.mode === "move") {
      let nx = Math.round(dr.ox + dx);
      let ny = Math.round(dr.oy + dy);
      const th = 7 / sc;
      let gx: number | null = null;
      let gy: number | null = null;
      const targX: [number, number][] = [[0, 0], [(doc.width - l.w) / 2, doc.width / 2], [doc.width - l.w, doc.width]];
      const targY: [number, number][] = [[0, 0], [(doc.height - l.h) / 2, doc.height / 2], [doc.height - l.h, doc.height]];
      for (const [pos, guide] of targX) if (Math.abs(nx - pos) < th) { nx = Math.round(pos); gx = guide; }
      for (const [pos, guide] of targY) if (Math.abs(ny - pos) < th) { ny = Math.round(pos); gy = guide; }
      setSnap({ x: gx, y: gy });
      onChange(dr.id, { x: nx, y: ny });
      return;
    }

    let nx = dr.ox, ny = dr.oy, nw = dr.ow, nh = dr.oh;
    if (dr.mode.includes("e")) nw = dr.ow + dx;
    if (dr.mode.includes("s")) nh = dr.oh + dy;
    if (dr.mode.includes("w")) { nw = dr.ow - dx; nx = dr.ox + dx; }
    if (dr.mode.includes("n")) { nh = dr.oh - dy; ny = dr.oy + dy; }
    if (nw < 20) nw = 20;
    if (nh < 20) nh = 20;
    const patch: Partial<Layer> = { x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh) } as Partial<Layer>;
    if (l.type === "text" && dr.ofs) (patch as { fontSize?: number }).fontSize = Math.max(8, Math.round(dr.ofs * (nh / dr.oh)));
    onChange(dr.id, patch);
  };

  const end = () => {
    drag.current = null;
    setSnap({ x: null, y: null });
  };

  const sel = selId ? doc.layers.find((l) => l.id === selId) : null;

  return (
    <div
      style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "28px", background: "var(--surface-base)", overflow: "auto", minHeight: 0 }}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerLeave={end}
    >
      <div style={{ position: "relative", width: dispW, height: dispH, flexShrink: 0, boxShadow: "0 24px 70px rgba(0,0,0,0.55)", borderRadius: 4 }}>
        {/* render (also the deselect surface) */}
        <div style={{ position: "absolute", inset: 0, borderRadius: 4, overflow: "hidden" }} onPointerDown={() => onSelect(null)} dangerouslySetInnerHTML={{ __html: svg }} />

        {/* per-layer hit boxes */}
        {doc.layers.map((l) =>
          l.visible ? (
            <div
              key={l.id}
              onPointerDown={(e) => startMove(e, l)}
              onDoubleClick={() => { if (l.type === "text") { onSelect(l.id); setEditingId(l.id); } }}
              style={{ position: "absolute", left: l.x * sc, top: l.y * sc, width: l.w * sc, height: l.h * sc, boxSizing: "border-box", cursor: l.locked ? "default" : "move", border: l.id === selId ? "1px solid var(--accent)" : "1px solid transparent", outline: l.id === selId ? "1px solid rgba(0,0,0,0.3)" : "none" }}
            />
          ) : null
        )}

        {/* resize handles for the selected layer */}
        {sel && !sel.locked &&
          HANDLES.map((hd) => {
            const left = (sel.x + (hd.includes("e") ? sel.w : 0)) * sc;
            const top = (sel.y + (hd.includes("s") ? sel.h : 0)) * sc;
            return (
              <div
                key={hd}
                onPointerDown={(e) => startResize(e, sel, hd)}
                style={{ position: "absolute", left: left - 6, top: top - 6, width: 12, height: 12, background: "#fff", border: "1.5px solid var(--accent)", borderRadius: 3, cursor: `${hd}-resize`, zIndex: 5 }}
              />
            );
          })}

        {/* inline text editor — double-click a text layer to edit in place */}
        {editing && editing.type === "text" && (
          <textarea
            autoFocus
            wrap="off"
            value={editing.text}
            onChange={(e) => onChange(editing.id, { text: e.target.value })}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onBlur={() => setEditingId(null)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditingId(null);
              }
            }}
            style={{
              whiteSpace: "pre",
              position: "absolute",
              left: editing.x * sc,
              top: editing.y * sc,
              width: editing.w * sc,
              height: editing.h * sc,
              boxSizing: "border-box",
              fontFamily: editing.fontFamily === "mono" ? "var(--font-mono)" : "var(--font-sans)",
              fontSize: editing.fontSize * sc,
              fontWeight: editing.weight,
              lineHeight: editing.lineHeight,
              letterSpacing: editing.letterSpacing * sc,
              color: editing.color,
              textAlign: editing.align,
              background: "rgba(0,0,0,0.18)",
              border: "1px solid var(--accent)",
              outline: "none",
              resize: "none",
              overflow: "hidden",
              padding: 0,
              margin: 0,
              zIndex: 10,
              caretColor: "var(--accent)",
            }}
          />
        )}

        {/* snap guides */}
        {snap.x !== null && <div style={{ position: "absolute", left: snap.x * sc, top: 0, width: 1, height: dispH, background: "var(--accent)", pointerEvents: "none" }} />}
        {snap.y !== null && <div style={{ position: "absolute", top: snap.y * sc, left: 0, height: 1, width: dispW, background: "var(--accent)", pointerEvents: "none" }} />}

        {/* static guides */}
        {guides && (
          <svg width={dispW} height={dispH} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {[1 / 3, 2 / 3].map((f) => (
              <g key={f} stroke="rgba(255,255,255,0.18)" strokeDasharray="5 5">
                <line x1={dispW * f} y1={0} x2={dispW * f} y2={dispH} />
                <line x1={0} y1={dispH * f} x2={dispW} y2={dispH * f} />
              </g>
            ))}
            <rect x={dispW * 0.06} y={dispH * 0.06} width={dispW * 0.88} height={dispH * 0.88} fill="none" stroke="rgba(52,194,142,0.4)" strokeDasharray="7 6" />
          </svg>
        )}
      </div>
    </div>
  );
}
