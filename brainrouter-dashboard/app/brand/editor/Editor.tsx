"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { SIZES } from "../brandPresets";
import { LOCKUPS, ROLES, type LockupKey } from "../brandPresets";
import type { Layer, TextLayer, ImageLayer, LogoLayer, ShapeLayer, BadgeLayer, Background } from "./types";
import { useEditor } from "./useEditor";
import { EditorCanvas } from "./EditorCanvas";
import { buildEditorSVG } from "./buildEditorSVG";
import { TEMPLATE_FACTORIES } from "./templates";
import { downloadPNGFromSVG, downloadSVGString } from "../exportUtil";

/* ── tiny styled controls ──────────────────────────────────────────────── */
const mono: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 600 };
const fieldBox: CSSProperties = { width: "100%", padding: "7px 9px", borderRadius: 6, background: "var(--surface-overlay)", border: "1px solid var(--border)", color: "var(--text)", fontSize: 13, outline: "none", fontFamily: "var(--font-sans)" };
const actBtn: CSSProperties = { padding: "6px 4px", borderRadius: 6, fontSize: 11.5, cursor: "pointer", background: "var(--surface-overlay)", border: "1px solid var(--border)", color: "var(--text-secondary)", fontWeight: 500 };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={mono}>{label}</span>
      {children}
    </label>
  );
}
function Num({ value, onChange, min, max, step }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} style={fieldBox} />;
}
function Range({ value, onChange, min, max, step }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number }) {
  return <input type="range" value={value} min={min} max={max} step={step ?? 1} onChange={(e) => onChange(Number(e.target.value))} style={{ width: "100%", accentColor: "var(--accent)" }} />;
}
/** Memory-Instrument palette — quick on-brand picks under every colour input. */
const SWATCHES = ["#34C28E", "#ECEFF2", "#9BA3AC", "#5E6670", "#14171A", "#0B0D0F", "#E0A063", "#3C434B"];
function Color({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <input type="color" value={value?.startsWith("#") ? value : "#34c28e"} onChange={(e) => onChange(e.target.value)} style={{ width: "100%", height: 34, padding: 2, borderRadius: 6, background: "var(--surface-overlay)", border: "1px solid var(--border)", cursor: "pointer" }} />
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {SWATCHES.map((c) => (
          <button key={c} type="button" title={c} onClick={() => onChange(c)} style={{ width: 18, height: 18, borderRadius: 4, background: c, border: value?.toLowerCase() === c.toLowerCase() ? "2px solid var(--accent)" : "1px solid var(--border)", cursor: "pointer", padding: 0 }} />
        ))}
      </div>
    </div>
  );
}
function Seg<T extends string>({ value, onChange, opts }: { value: T; onChange: (v: T) => void; opts: { v: T; label: string }[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${opts.length}, 1fr)`, gap: 4 }}>
      {opts.map((o) => (
        <button key={o.v} type="button" onClick={() => onChange(o.v)} style={{ padding: "6px 4px", borderRadius: 6, fontSize: 12, cursor: "pointer", background: o.v === value ? "var(--accent-wash)" : "var(--surface-overlay)", border: `1px solid ${o.v === value ? "var(--border-hover-accent)" : "var(--border)"}`, color: o.v === value ? "var(--accent)" : "var(--text-secondary)", fontWeight: o.v === value ? 600 : 500 }}>{o.label}</button>
      ))}
    </div>
  );
}
function tbBtn(active = false): CSSProperties {
  return { padding: "7px 12px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", background: active ? "var(--accent)" : "var(--surface-overlay)", border: `1px solid ${active ? "var(--accent)" : "var(--border-strong)"}`, color: active ? "#06130E" : "var(--text)" };
}

function readImage(file: File, cb: (dataUrl: string) => void) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 1400;
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
      cb(c.toDataURL("image/jpeg", 0.92));
    };
    img.src = reader.result as string;
  };
  reader.readAsDataURL(file);
}

/* ── layers panel ──────────────────────────────────────────────────────── */
function LayersPanel({ ed }: { ed: ReturnType<typeof useEditor> }) {
  const { doc, selId, setSelId, update, remove, duplicate, reorder } = ed;
  const ic = (p: string) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={p} /></svg>;
  return (
    <div style={{ width: 220, flexShrink: 0, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", background: "var(--surface-raised)" }}>
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", ...mono }}>Layers</div>
      <div style={{ flex: 1, overflowY: "auto", padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
        {[...doc.layers].reverse().map((l) => (
          <div key={l.id} onClick={() => setSelId(l.id)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 8px", borderRadius: 6, cursor: "pointer", background: l.id === selId ? "var(--accent-wash)" : "transparent", border: `1px solid ${l.id === selId ? "var(--border-hover-accent)" : "transparent"}` }}>
            <button title={l.visible ? "Hide" : "Show"} onClick={(e) => { e.stopPropagation(); update(l.id, { visible: !l.visible }); }} style={{ background: "none", border: "none", color: l.visible ? "var(--text-secondary)" : "var(--text-muted)", cursor: "pointer", padding: 0 }}>{ic(l.visible ? "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" : "M2 12s3.5-7 10-7 10 7 10 7M1 1l22 22")}</button>
            <span style={{ flex: 1, fontSize: 12.5, color: l.visible ? "var(--text)" : "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.type === "text" ? (l as TextLayer).text.slice(0, 18) || "Text" : l.type === "badge" ? (l as BadgeLayer).label || "Badge" : l.name}</span>
            <button title="Lock" onClick={(e) => { e.stopPropagation(); update(l.id, { locked: !l.locked }); }} style={{ background: "none", border: "none", color: l.locked ? "var(--accent)" : "var(--text-muted)", cursor: "pointer", padding: 0 }}>{ic(l.locked ? "M5 11V7a7 7 0 0 1 14 0M5 11h14v10H5z" : "M7 11V7a5 5 0 0 1 9.9-1M5 11h14v10H5z")}</button>
          </div>
        ))}
        {!doc.layers.length && <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>No layers yet — add one above.</div>}
      </div>
      {selId && (
        <div style={{ display: "flex", gap: 4, padding: 8, borderTop: "1px solid var(--border)" }}>
          <button onClick={() => reorder(selId, "up")} style={{ ...tbBtn(), flex: 1, padding: "6px 0" }} title="Bring forward">↑</button>
          <button onClick={() => reorder(selId, "down")} style={{ ...tbBtn(), flex: 1, padding: "6px 0" }} title="Send back">↓</button>
          <button onClick={() => duplicate(selId)} style={{ ...tbBtn(), flex: 1, padding: "6px 0", fontSize: 11 }} title="Duplicate">Dup</button>
          <button onClick={() => remove(selId)} style={{ ...tbBtn(), flex: 1, padding: "6px 0", fontSize: 11, color: "#E5675F" }} title="Delete">Del</button>
        </div>
      )}
    </div>
  );
}

/* ── inspector ─────────────────────────────────────────────────────────── */
function Inspector({ ed }: { ed: ReturnType<typeof useEditor> }) {
  const { doc, selId, update, setBg, updateDoc, setCanvasSize } = ed;
  const l = selId ? doc.layers.find((x) => x.id === selId) : null;
  const up = (patch: Partial<Layer>) => l && update(l.id, patch);

  return (
    <div style={{ width: 296, flexShrink: 0, borderLeft: "1px solid var(--border)", background: "var(--surface-raised)", overflowY: "auto" }}>
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", ...mono }}>{l ? `${l.type} layer` : "Canvas"}</div>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
        {!l && (
          <>
            <Row label="Canvas size">
              <select value={`${doc.width}x${doc.height}`} onChange={(e) => { const [w, h] = e.target.value.split("x").map(Number); setCanvasSize(w, h); }} style={fieldBox}>
                {Object.keys(SIZES).map((k) => <option key={k} value={`${SIZES[k].w}x${SIZES[k].h}`}>{SIZES[k].label} · {SIZES[k].note}</option>)}
                {!Object.keys(SIZES).some((k) => SIZES[k].w === doc.width && SIZES[k].h === doc.height) && <option value={`${doc.width}x${doc.height}`}>Custom · {doc.width}×{doc.height}</option>}
              </select>
            </Row>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Row label="Width"><Num value={doc.width} onChange={(v) => updateDoc({ width: Math.max(64, v) })} /></Row>
              <Row label="Height"><Num value={doc.height} onChange={(v) => updateDoc({ height: Math.max(64, v) })} /></Row>
            </div>
            <Row label="Background"><Seg<Background["type"]> value={doc.background.type} onChange={(v) => setBg({ type: v })} opts={[{ v: "rosette", label: "Guilloché" }, { v: "grid", label: "Grid" }, { v: "solid", label: "Solid" }]} /></Row>
            <Seg<Background["type"]> value={doc.background.type} onChange={(v) => setBg({ type: v })} opts={[{ v: "gradient", label: "Gradient" }, { v: "transparent", label: "None" }]} />
            {(doc.background.type === "solid" || doc.background.type === "grid" || doc.background.type === "rosette") && <Row label="Color"><Color value={doc.background.color} onChange={(v) => setBg({ color: v })} /></Row>}
            {doc.background.type === "gradient" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Row label="From"><Color value={doc.background.from} onChange={(v) => setBg({ from: v })} /></Row>
                <Row label="To"><Color value={doc.background.to} onChange={(v) => setBg({ to: v })} /></Row>
              </div>
            )}
            {(doc.background.type === "rosette" || doc.background.type === "grid") && <Row label="Accent"><Color value={doc.background.accent} onChange={(v) => setBg({ accent: v })} /></Row>}
            <Row label="Background image">
              <label style={{ ...tbBtn(), textAlign: "center" }}>Upload<input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) readImage(f, (src) => setBg({ type: "image", src })); }} /></label>
            </Row>
            <p style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5, margin: 0 }}>Tip: drag to move, drag corners to resize, double-click text to edit.</p>
          </>
        )}

        {l && (
          <>
            {/* Arrange — position, size, align to the frame */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Row label="X"><Num value={Math.round(l.x)} onChange={(v) => up({ x: v })} /></Row>
              <Row label="Y"><Num value={Math.round(l.y)} onChange={(v) => up({ y: v })} /></Row>
            </div>
            {(l.type === "image" || l.type === "shape") && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Row label="Width"><Num value={Math.round(l.w)} min={8} onChange={(v) => up({ w: v })} /></Row>
                <Row label="Height"><Num value={Math.round(l.h)} min={8} onChange={(v) => up({ h: v })} /></Row>
              </div>
            )}
            <Row label="Align to canvas">
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 4 }}>
                  <button type="button" style={actBtn} onClick={() => up({ x: 0 })}>Left</button>
                  <button type="button" style={actBtn} onClick={() => up({ x: Math.round((doc.width - l.w) / 2) })}>Center</button>
                  <button type="button" style={actBtn} onClick={() => up({ x: Math.round(doc.width - l.w) })}>Right</button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 4 }}>
                  <button type="button" style={actBtn} onClick={() => up({ y: 0 })}>Top</button>
                  <button type="button" style={actBtn} onClick={() => up({ y: Math.round((doc.height - l.h) / 2) })}>Middle</button>
                  <button type="button" style={actBtn} onClick={() => up({ y: Math.round(doc.height - l.h) })}>Bottom</button>
                </div>
              </div>
            </Row>
            <div style={{ height: 1, background: "var(--border)", margin: "2px 0" }} />

            {l.type === "text" && (() => { const t = l as TextLayer; return <>
              <Row label="Text"><textarea value={t.text} rows={2} onChange={(e) => up({ text: e.target.value })} style={{ ...fieldBox, resize: "vertical" }} /></Row>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Row label="Size"><Num value={t.fontSize} min={6} onChange={(v) => up({ fontSize: v })} /></Row>
                <Row label="Weight"><select value={t.weight} onChange={(e) => up({ weight: Number(e.target.value) })} style={fieldBox}>{[400, 500, 600, 700, 800].map((w) => <option key={w} value={w}>{w}</option>)}</select></Row>
              </div>
              <Row label="Font"><Seg<"sans" | "mono"> value={t.fontFamily} onChange={(v) => up({ fontFamily: v })} opts={[{ v: "sans", label: "Geist" }, { v: "mono", label: "Mono" }]} /></Row>
              <Row label="Align"><Seg<"left" | "center" | "right"> value={t.align} onChange={(v) => up({ align: v })} opts={[{ v: "left", label: "L" }, { v: "center", label: "C" }, { v: "right", label: "R" }]} /></Row>
              <Row label="Color"><Color value={t.color} onChange={(v) => up({ color: v })} /></Row>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Row label={`Tracking ${t.letterSpacing}`}><Range value={t.letterSpacing} min={-8} max={16} onChange={(v) => up({ letterSpacing: v })} /></Row>
                <Row label={`Line ${t.lineHeight}`}><Range value={t.lineHeight} min={0.9} max={2} step={0.05} onChange={(v) => up({ lineHeight: v })} /></Row>
              </div>
              <Row label="Effect"><Seg<"none" | "shadow" | "outline"> value={t.effect} onChange={(v) => up({ effect: v })} opts={[{ v: "none", label: "None" }, { v: "shadow", label: "Shadow" }, { v: "outline", label: "Outline" }]} /></Row>
              {t.effect !== "none" && <Row label="Effect color"><Color value={t.effectColor} onChange={(v) => up({ effectColor: v })} /></Row>}
            </>; })()}

            {l.type === "image" && (() => { const im = l as ImageLayer; return <>
              <Row label="Photo"><label style={{ ...tbBtn(), textAlign: "center" }}>{im.src ? "Replace" : "Upload"}<input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) readImage(f, (src) => up({ src })); }} /></label></Row>
              <Row label={`Corner radius ${im.radius}`}><Range value={im.radius} min={0} max={Math.round(Math.min(im.w, im.h) / 2)} onChange={(v) => up({ radius: v })} /></Row>
            </>; })()}

            {l.type === "logo" && (() => { const lg = l as LogoLayer; return <>
              <Row label="Lockup"><Seg<LockupKey> value={lg.lockup} onChange={(v) => up({ lockup: v })} opts={(Object.keys(LOCKUPS) as LockupKey[]).map((k) => ({ v: k, label: LOCKUPS[k] }))} /></Row>
              <Row label="Color"><Color value={lg.color} onChange={(v) => up({ color: v })} /></Row>
            </>; })()}

            {l.type === "badge" && (() => { const bd = l as BadgeLayer; return <>
              <Row label="Label"><input value={bd.label} onChange={(e) => up({ label: e.target.value })} style={fieldBox} /></Row>
              <Row label="Role icon"><select value={bd.roleKey} onChange={(e) => up({ roleKey: e.target.value })} style={fieldBox}>{Object.keys(ROLES).map((k) => <option key={k} value={k}>{ROLES[k]}</option>)}</select></Row>
              <Row label="Style"><Seg<"glass" | "solid"> value={bd.style} onChange={(v) => up({ style: v })} opts={[{ v: "solid", label: "Solid" }, { v: "glass", label: "Glass" }]} /></Row>
              <Row label="Color"><Color value={bd.color} onChange={(v) => up({ color: v })} /></Row>
              <Row label={`Size ${Math.round(bd.h / 2.15)}`}><Range value={Math.round(bd.h / 2.15)} min={16} max={120} onChange={(v) => up({ h: Math.round(v * 2.15) })} /></Row>
            </>; })()}

            {l.type === "shape" && (() => { const sh = l as ShapeLayer; return <>
              <Row label="Shape"><Seg<"rect" | "ellipse" | "line"> value={sh.shape} onChange={(v) => up({ shape: v })} opts={[{ v: "rect", label: "Rect" }, { v: "ellipse", label: "Ellipse" }, { v: "line", label: "Line" }]} /></Row>
              {sh.shape !== "line" && <Row label="Fill"><Color value={sh.fill === "none" ? "#34c28e" : sh.fill} onChange={(v) => up({ fill: v })} /></Row>}
              {sh.shape !== "line" && <button onClick={() => up({ fill: sh.fill === "none" ? "#34C28E" : "none" })} style={{ ...tbBtn(), padding: "6px 10px" }}>{sh.fill === "none" ? "Add fill" : "No fill"}</button>}
              <Row label="Stroke"><Color value={sh.stroke === "none" ? "#34c28e" : sh.stroke} onChange={(v) => up({ stroke: v, strokeWidth: sh.strokeWidth || 4 })} /></Row>
              <Row label={`Stroke width ${sh.strokeWidth}`}><Range value={sh.strokeWidth} min={0} max={40} onChange={(v) => up({ strokeWidth: v })} /></Row>
              {sh.shape === "rect" && <Row label={`Corner ${sh.radius}`}><Range value={sh.radius} min={0} max={Math.round(Math.min(sh.w, sh.h) / 2)} onChange={(v) => up({ radius: v })} /></Row>}
            </>; })()}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Row label={`Opacity ${Math.round(l.opacity * 100)}`}><Range value={l.opacity} min={0} max={1} step={0.01} onChange={(v) => up({ opacity: v })} /></Row>
              <Row label={`Rotate ${l.rotation}°`}><Range value={l.rotation} min={-180} max={180} onChange={(v) => up({ rotation: v })} /></Row>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── editor ────────────────────────────────────────────────────────────── */
export function Editor() {
  const ed = useEditor();
  const { doc, selId, setSelId, update, add, remove, loadTemplate, setCanvasSize, fitContent } = ed;
  const [scale, setScale] = useState(2);

  const exportName = `brainrouter-${doc.width}x${doc.height}`;
  const doPNG = () => downloadPNGFromSVG(buildEditorSVG(doc), doc.width, doc.height, `${exportName}.png`, scale);
  const doSVG = () => downloadSVGString(buildEditorSVG(doc), `${exportName}.svg`);

  // keyboard: delete removes, arrows nudge
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!selId) return;
      const l = doc.layers.find((x) => x.id === selId);
      if (!l) return;
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(selId); }
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowLeft") { e.preventDefault(); update(selId, { x: l.x - step }); }
      if (e.key === "ArrowRight") { e.preventDefault(); update(selId, { x: l.x + step }); }
      if (e.key === "ArrowUp") { e.preventDefault(); update(selId, { y: l.y - step }); }
      if (e.key === "ArrowDown") { e.preventDefault(); update(selId, { y: l.y + step }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selId, doc.layers, remove, update]);

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-panel)", overflow: "hidden", display: "flex", flexDirection: "column", height: "calc(100vh - 232px)", minHeight: 440 }}>
      {/* toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)", background: "var(--surface-raised)", flexWrap: "wrap" }}>
        <span style={mono}>Add</span>
        <button style={tbBtn()} onClick={() => add("text")}>Text</button>
        <button style={tbBtn()} onClick={() => add("logo")}>Logo</button>
        <button style={tbBtn()} onClick={() => add("badge")}>Badge</button>
        <button style={tbBtn()} onClick={() => add("shape")}>Shape</button>
        <label style={{ ...tbBtn() }}>Image<input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) readImage(f, (src) => ed.addImage(src)); e.currentTarget.value = ""; }} /></label>
        <div style={{ width: 1, height: 22, background: "var(--border)", margin: "0 4px" }} />
        <select onChange={(e) => { const f = TEMPLATE_FACTORIES.find((x) => x.key === e.target.value); if (f) loadTemplate(f.make); }} value="" style={{ ...fieldBox, width: "auto", padding: "7px 10px" }}>
          <option value="" disabled>Template…</option>
          {TEMPLATE_FACTORIES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
        <div style={{ width: 1, height: 22, background: "var(--border)", margin: "0 4px" }} />
        <select value={`${doc.width}x${doc.height}`} onChange={(e) => { const [w, h] = e.target.value.split("x").map(Number); setCanvasSize(w, h); }} title="Canvas size" style={{ ...fieldBox, width: "auto", padding: "7px 8px" }}>
          {Object.keys(SIZES).map((k) => <option key={k} value={`${SIZES[k].w}x${SIZES[k].h}`}>{SIZES[k].label} · {SIZES[k].w}×{SIZES[k].h}</option>)}
          {!Object.keys(SIZES).some((k) => SIZES[k].w === doc.width && SIZES[k].h === doc.height) && <option value={`${doc.width}x${doc.height}`}>Custom · {doc.width}×{doc.height}</option>}
        </select>
        <button style={tbBtn()} onClick={fitContent} title="Scale & centre all layers to fit the frame">Fit</button>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <select value={scale} onChange={(e) => setScale(Number(e.target.value))} title="PNG resolution" style={{ ...fieldBox, width: "auto", padding: "7px 8px" }}>
            <option value={1}>1×</option>
            <option value={2}>2× HD</option>
            <option value={3}>3×</option>
            <option value={4}>4×</option>
          </select>
          <button style={tbBtn()} onClick={doSVG}>SVG</button>
          <button style={tbBtn(true)} onClick={doPNG}>PNG {Math.round(doc.width * scale)}×{Math.round(doc.height * scale)}</button>
        </div>
      </div>
      {/* body */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <LayersPanel ed={ed} />
        <EditorCanvas doc={doc} selId={selId} onSelect={setSelId} onChange={update} guides={false} />
        <Inspector ed={ed} />
      </div>
    </div>
  );
}
