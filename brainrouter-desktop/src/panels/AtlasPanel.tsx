/**
 * Atlas panel — the interactive codebase knowledge graph (ATLAS-5/10).
 *
 * Two reading altitudes:
 *  - Overview   — architectural LAYER cards (enriched graphs); click to drill in.
 *  - Structural — files clustered into titled containers (by layer, else dir),
 *                 coloured by category, with import edges; the real map.
 * Plus a node detail card, a guided tour, search spotlight, category filters,
 * a drill breadcrumb, and open-in-editor. Styling tracks the app theme.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AtlasFileCategory, AtlasGraph, AtlasNode, AtlasNodeType } from "@kinqs/brainrouter-types";
import {
  atlasGrouping, atlasGroupedLayout, atlasOverviewModel, atlasNodeColor, atlasSearchMatches,
  ATLAS_FILE_CATEGORIES, ATLAS_CATEGORY_COLORS,
} from "../lib/atlas/atlasView.js";
import { ATLAS_NODE_TYPES } from "./AtlasNodes.js";
import { AtlasDetail } from "./AtlasDetail.js";
import { Icon } from "../icons.js";

type Mode = "overview" | "structural";

export interface AtlasPanelProps {
  graph: AtlasGraph | null;
  building: boolean;
  enriching?: boolean;
  onBuild: () => void;
  onEnrich?: () => void;
  onSelectNode?: (nodeId: string, filePath?: string) => void;
  onOpenFile?: (path: string) => void;
  onLoad?: () => void;
}

function fileColor(n: AtlasNode): string {
  if (n.category && ATLAS_CATEGORY_COLORS[n.category]) return ATLAS_CATEGORY_COLORS[n.category];
  return atlasNodeColor(n.type);
}

export function AtlasPanel({ graph, building, enriching = false, onBuild, onEnrich, onSelectNode, onOpenFile, onLoad }: AtlasPanelProps): React.ReactElement {
  const [selected, setSelected] = useState<string | null>(null);
  const [tourStep, setTourStep] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("overview");
  const [drill, setDrill] = useState<string | null>(null); // layer id drilled into (structural)
  const [disabledCats, setDisabledCats] = useState<ReadonlySet<AtlasFileCategory>>(new Set());
  const rfRef = useRef<ReactFlowInstance | null>(null);

  useEffect(() => {
    if (!graph) onLoad?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byId = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n] as const)), [graph]);
  const hasLayers = !!graph && graph.layers.length > 0;
  const effMode: Mode = hasLayers ? mode : "structural";

  // Categories actually present (for the filter pills).
  const presentCats = useMemo(() => {
    const s = new Set<AtlasFileCategory>();
    for (const n of graph?.nodes ?? []) if (n.category) s.add(n.category);
    return ATLAS_FILE_CATEGORIES.filter((c) => s.has(c));
  }, [graph]);

  // Drill scope: the drilled layer's node ids (structural only).
  const scope = useMemo<ReadonlySet<string> | undefined>(() => {
    if (!graph || effMode !== "structural" || !drill) return undefined;
    const layer = graph.layers.find((l) => l.id === drill);
    return layer ? new Set(layer.nodeIds) : undefined;
  }, [graph, effMode, drill]);

  // ---- tour + search spotlight (search maps symbol→its file) ----
  const tourIds = useMemo(() => {
    if (tourStep == null || !graph) return null;
    const step = graph.tour[tourStep];
    return step && step.nodeIds.length ? new Set(step.nodeIds) : new Set<string>();
  }, [tourStep, graph]);

  const searchIds = useMemo(() => {
    if (tourStep != null || !graph || !query.trim()) return null;
    const out = new Set<string>();
    const fileByPath = new Map<string, string>();
    for (const n of graph.nodes) if (n.filePath) fileByPath.set(n.filePath, n.id);
    for (const id of atlasSearchMatches(graph, query)) {
      const n = byId.get(id);
      if (n && (n.type === "function" || n.type === "class") && n.filePath && fileByPath.has(n.filePath)) out.add(fileByPath.get(n.filePath)!);
      else out.add(id);
    }
    return out;
  }, [graph, query, tourStep, byId]);

  const spotlight = useMemo(() => tourIds ?? searchIds, [tourIds, searchIds]);

  // ---- model per mode ----
  const overview = useMemo(() => (graph && effMode === "overview" ? atlasOverviewModel(graph) : null), [graph, effMode]);

  const structural = useMemo(() => {
    if (!graph || effMode !== "structural") return null;
    const catScope = new Set(
      graph.nodes.filter((n) => (!scope || scope.has(n.id)) && (!n.category || !disabledCats.has(n.category))).map((n) => n.id),
    );
    const groups = atlasGrouping(graph, catScope);
    return { layout: atlasGroupedLayout(groups), visible: catScope };
  }, [graph, effMode, scope, disabledCats]);

  // ---- React Flow nodes/edges ----
  const { rfNodes, rfEdges } = useMemo<{ rfNodes: Node[]; rfEdges: Edge[] }>(() => {
    if (!graph) return { rfNodes: [], rfEdges: [] };
    if (effMode === "overview" && overview) {
      const cardW = 268;
      const cardH = 152;
      const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(overview.cards.length))));
      const nodes: Node[] = overview.cards.map((c, i) => ({
        id: c.id,
        type: "atlasLayer",
        position: { x: (i % cols) * (cardW + 44), y: Math.floor(i / cols) * (cardH + 44) },
        data: { name: c.name, description: c.description, fileCount: c.fileCount, complexity: c.complexity },
        style: { width: cardW },
      }));
      const edges: Edge[] = overview.edges.map((e, i) => ({
        id: `oe${i}`, source: e.source, target: e.target,
        style: { stroke: "var(--border-strong)", strokeWidth: 1 }, label: e.weight > 1 ? String(e.weight) : undefined,
      }));
      return { rfNodes: nodes, rfEdges: edges };
    }
    if (effMode === "structural" && structural) {
      const { layout, visible } = structural;
      const groupNodes: Node[] = layout.groups.map((b) => ({
        id: b.id, type: "atlasGroup", position: { x: b.x, y: b.y },
        data: { label: b.label, count: b.count },
        style: { width: b.width, height: b.height }, selectable: false, draggable: false, zIndex: 0,
      }));
      const fileNodes: Node[] = [];
      for (const [id, pos] of layout.positions) {
        const n = byId.get(id);
        if (!n) continue;
        fileNodes.push({
          id, type: "atlasFile", parentId: layout.groupOf.get(id), extent: "parent", position: pos,
          data: { label: n.name, color: fileColor(n), dim: spotlight ? !spotlight.has(id) : false, hot: !!spotlight?.has(id), selected: selected === id },
        });
      }
      const edges: Edge[] = [];
      let count = 0;
      for (const e of graph.edges) {
        if (e.type !== "imports" || !visible.has(e.source) || !visible.has(e.target)) continue;
        if (++count > 500) break; // perf cap on very large graphs
        edges.push({ id: `se${edges.length}`, source: e.source, target: e.target, style: { stroke: "var(--border)", strokeWidth: 1 } });
      }
      return { rfNodes: [...groupNodes, ...fileNodes], rfEdges: edges };
    }
    return { rfNodes: [], rfEdges: [] };
  }, [graph, effMode, overview, structural, spotlight, selected, byId]);

  // fit to spotlight when searching/touring
  useEffect(() => {
    if (!rfRef.current || !spotlight || spotlight.size === 0) return;
    rfRef.current.fitView({ nodes: [...spotlight].map((id) => ({ id })), duration: 450, padding: 0.45 });
  }, [spotlight]);

  // re-fit when the mode/drill/filter changes the whole layout
  useEffect(() => {
    if (!rfRef.current) return;
    const raf = requestAnimationFrame(() => rfRef.current?.fitView({ duration: 300, padding: 0.18 }));
    return () => cancelAnimationFrame(raf);
  }, [effMode, drill, disabledCats]);

  // Esc: leave drill → overview, else clear selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (drill) { setDrill(null); setMode("overview"); }
      else if (selected) setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drill, selected]);

  if (!graph) {
    return (
      <div className="atlas-empty">
        <Icon name="atlas" size={40} />
        <div className="atlas-empty-title">No atlas yet</div>
        <div className="atlas-empty-desc">Build an interactive knowledge graph of this workspace — every file, function and class, grouped and connected.</div>
        <button className="btn primary" disabled={building} onClick={onBuild}>{building ? "Building…" : "Build atlas"}</button>
      </div>
    );
  }

  const enrichedCount = graph.nodes.filter((n) => n.summary).length;
  const busy = building || enriching;
  const drillName = drill ? graph.layers.find((l) => l.id === drill)?.name : null;

  const toggleCat = (c: AtlasFileCategory): void => {
    setDisabledCats((prev) => {
      const next = new Set(prev);
      next.has(c) ? next.delete(c) : next.add(c);
      return next;
    });
  };

  return (
    <div className="atlas-panel">
      <div className="atlas-toolbar">
        {hasLayers ? (
          <div className="atlas-modes">
            <button className={`atlas-mode${effMode === "overview" ? " on" : ""}`} onClick={() => { setMode("overview"); setDrill(null); }}>Overview</button>
            <button className={`atlas-mode${effMode === "structural" ? " on" : ""}`} onClick={() => setMode("structural")}>Structural</button>
          </div>
        ) : null}
        <span className="atlas-proj">{graph.project.name}</span>
        {enrichedCount ? <span className="atlas-count atlas-enriched" title={`${enrichedCount} files summarised`}>· {graph.layers.length} layers · {graph.tour.length} tour</span> : null}
        {effMode === "structural" && presentCats.length ? (
          <div className="atlas-cats">
            {presentCats.map((c) => (
              <button key={c} className={`atlas-cat${disabledCats.has(c) ? " off" : ""}`} onClick={() => toggleCat(c)} title={`Toggle ${c}`}>
                <span className="atlas-cat-dot" style={{ background: ATLAS_CATEGORY_COLORS[c] }} />{c}
              </button>
            ))}
          </div>
        ) : null}
        <label className="atlas-search">
          <Icon name="search" size={12} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }} placeholder="Search…" spellCheck={false} />
          {query.trim() ? <span className="atlas-search-count">{searchIds?.size ?? 0}</span> : null}
        </label>
        <span className="atlas-spacer" />
        {graph.tour.length ? <button className="btn" disabled={busy} onClick={() => { setSelected(null); setTourStep(tourStep == null ? 0 : null); }} title="Walk a guided tour">{tourStep == null ? "Tour" : "Exit tour"}</button> : null}
        {onEnrich ? <button className="btn" disabled={busy} onClick={onEnrich} title="Add LLM summaries, layers, and a guided tour">{enriching ? "Enriching…" : enrichedCount ? "Re-enrich" : "Enrich"}</button> : null}
        <button className="btn" disabled={busy} onClick={onBuild} title="Rebuild from the current code">{building ? "Building…" : "Rebuild"}</button>
      </div>

      <div className="atlas-breadcrumb">
        <button className="atlas-crumb" onClick={() => { setMode(hasLayers ? "overview" : "structural"); setDrill(null); }}>{graph.project.name}</button>
        {drillName ? <><span className="atlas-crumb-sep">›</span><span className="atlas-crumb cur">{drillName}</span><span className="atlas-crumb-esc">Esc to go back</span></> : <span className="atlas-crumb-mode">{effMode === "overview" ? "Overview" : "Structural"}</span>}
      </div>

      <div className="atlas-canvas">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={ATLAS_NODE_TYPES}
          fitView
          minZoom={0.04}
          maxZoom={2.5}
          proOptions={{ hideAttribution: true }}
          onInit={(inst) => { rfRef.current = inst; }}
          onNodeClick={(_e, n) => {
            if (n.type === "atlasLayer") { setDrill(n.id); setMode("structural"); return; }
            if (n.type === "atlasFile") {
              setSelected(n.id);
              onSelectNode?.(n.id, byId.get(n.id)?.filePath);
            }
          }}
          onNodeDoubleClick={(_e, n) => {
            const fp = byId.get(n.id)?.filePath;
            if (n.type === "atlasFile" && fp) onOpenFile?.(fp);
          }}
          onPaneClick={() => setSelected(null)}
        >
          <Background color="var(--border)" gap={24} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => {
            if (n.type === "atlasGroup") return "transparent";
            const gn = byId.get(n.id);
            return gn ? fileColor(gn) : "var(--accent)";
          }} maskColor="rgba(0,0,0,0.55)" style={{ background: "var(--surface)", border: "1px solid var(--border)" }} />
        </ReactFlow>

        {selected ? <AtlasDetail graph={graph} nodeId={selected} onClose={() => setSelected(null)} onOpenFile={onOpenFile} /> : null}

        {tourStep != null && graph.tour[tourStep] ? (
          <div className="atlas-tour">
            <div className="atlas-tour-top">
              <span className="atlas-tour-progress">Step {tourStep + 1} of {graph.tour.length}</span>
              <button className="atlas-detail-x" aria-label="Exit tour" title="Exit tour" onClick={() => setTourStep(null)}><Icon name="close" size={11} /></button>
            </div>
            <div className="atlas-tour-title">{graph.tour[tourStep].title}</div>
            <div className="atlas-tour-desc">{graph.tour[tourStep].description}</div>
            <div className="atlas-tour-nav">
              <button className="btn" disabled={tourStep === 0} onClick={() => setTourStep(Math.max(0, tourStep - 1))}>Prev</button>
              {tourStep < graph.tour.length - 1
                ? <button className="btn primary" onClick={() => setTourStep(tourStep + 1)}>Next</button>
                : <button className="btn primary" onClick={() => setTourStep(null)}>Done</button>}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
