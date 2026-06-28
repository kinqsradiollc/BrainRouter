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
import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AtlasFileCategory, AtlasGraph, AtlasNode, AtlasNodeType } from "@kinqs/brainrouter-types";
import {
  atlasGrouping, atlasGroupedLayout, atlasOverviewModel, atlasDomainModel, atlasServiceModel, atlasNodeColor, atlasSearchMatches,
  atlasChangeMap, atlasNodeChanges, atlasImpact, atlasImpactOf, atlasUncoveredFiles, atlasProjectStats, ATLAS_FILE_CATEGORIES, ATLAS_CATEGORY_COLORS,
  type AtlasChangeKind, type AtlasChangeAssessment,
} from "../lib/atlas/atlasView.js";
import { ATLAS_NODE_TYPES } from "./AtlasNodes.js";
import { layeredLayout } from "../lib/atlas/layeredLayout.js";
import { AtlasDetail } from "./AtlasDetail.js";
import { Icon } from "../icons.js";

type Mode = "overview" | "structural" | "domain" | "services";

export interface AtlasPanelProps {
  graph: AtlasGraph | null;
  building: boolean;
  enriching?: boolean;
  onBuild: () => void;
  onEnrich?: () => void;
  onSelectNode?: (nodeId: string, filePath?: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onLoad?: () => void;
  /** Working-tree changes (path + git porcelain status) for the Review overlay. */
  changedFiles?: ReadonlyArray<{ path: string; status: string }>;
  /** AI change assessments by file path (ATLAS-14). */
  assessments?: Record<string, AtlasChangeAssessment>;
  /** File path currently being assessed (spinner). */
  assessing?: string | null;
  /** Request an LLM assessment of a changed file. */
  onAssess?: (path: string) => void;
}

function fileColor(n: AtlasNode): string {
  if (n.category && ATLAS_CATEGORY_COLORS[n.category]) return ATLAS_CATEGORY_COLORS[n.category];
  return atlasNodeColor(n.type);
}

export function AtlasPanel({ graph, building, enriching = false, onBuild, onEnrich, onSelectNode, onOpenFile, onLoad, changedFiles, assessments, assessing, onAssess }: AtlasPanelProps): React.ReactElement {
  const [selected, setSelected] = useState<string | null>(null);
  const [tourStep, setTourStep] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("overview");
  const [drill, setDrill] = useState<string | null>(null); // layer id drilled into (structural)
  const [disabledCats, setDisabledCats] = useState<ReadonlySet<AtlasFileCategory>>(new Set());
  const [showDiff, setShowDiff] = useState(false); // Review overlay (ATLAS-11)
  const [impactNode, setImpactNode] = useState<string | null>(null); // blast-radius highlight (ATLAS-13)
  const [highlightNode, setHighlightNode] = useState<string | null>(null); // click-to-highlight connections
  const [showInsights, setShowInsights] = useState(false); // Deep Dive stats overlay
  const rfRef = useRef<ReactFlowInstance | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    if (!graph) onLoad?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0) return;
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const byId = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n] as const)), [graph]);
  const fileIdByPath = useMemo(() => {
    const out = new Map<string, string>();
    for (const n of graph?.nodes ?? []) if (n.filePath) out.set(n.filePath, n.id);
    return out;
  }, [graph]);

  // Review overlay: node id → git change kind (added/modified/untracked/…).
  const nodeChanges = useMemo<Map<string, AtlasChangeKind>>(
    () => (graph && changedFiles?.length ? atlasNodeChanges(graph, atlasChangeMap(changedFiles)) : new Map()),
    [graph, changedFiles],
  );
  const changedCount = nodeChanges.size;

  // Files with no test covering them (ATLAS-15) — flagged in Review.
  const uncovered = useMemo(() => (graph && (showDiff || selected) ? atlasUncoveredFiles(graph) : new Set<string>()), [graph, showDiff, selected]);
  const untestedChanged = useMemo(() => {
    if (!showDiff) return 0;
    let n = 0;
    for (const id of nodeChanges.keys()) if (uncovered.has(id)) n++;
    return n;
  }, [showDiff, nodeChanges, uncovered]);

  // Service map (Wave 3) — computed always (cheap) so the toolbar can offer the
  // mode whenever the codebase exposes typed service ports, layers or not.
  const serviceModel = useMemo(() => (graph ? atlasServiceModel(graph) : null), [graph]);
  const hasServices = !!serviceModel && serviceModel.cards.length > 0;

  const hasLayers = !!graph && graph.layers.length > 0;
  const effMode: Mode =
    mode === "services" ? (hasServices ? "services" : "structural") : hasLayers ? mode : "structural";

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
    if (tourStep != null || !graph || !deferredQuery.trim()) return null;
    const out = new Set<string>();
    for (const id of atlasSearchMatches(graph, deferredQuery)) {
      const n = byId.get(id);
      if (n && (n.type === "function" || n.type === "class") && n.filePath && fileIdByPath.has(n.filePath)) out.add(fileIdByPath.get(n.filePath)!);
      else out.add(id);
    }
    return out;
  }, [graph, deferredQuery, tourStep, byId, fileIdByPath]);

  // Review overlay spotlights the changed nodes (tour/search take precedence).
  const diffIds = useMemo(() => (showDiff && changedCount ? new Set(nodeChanges.keys()) : null), [showDiff, changedCount, nodeChanges]);
  // Blast radius: the node + everything that (transitively) imports it.
  const impactIds = useMemo(() => {
    if (!impactNode || !graph) return null;
    return new Set<string>([impactNode, ...atlasImpact(graph, impactNode).dependents]);
  }, [impactNode, graph]);
  // Precedence: impact highlight > tour > search > review overlay.
  const spotlight = useMemo(() => impactIds ?? tourIds ?? searchIds ?? diffIds, [impactIds, tourIds, searchIds, diffIds]);
  // Only INTENTIONAL focus (impact click / tour / search) should auto-zoom the
  // canvas. The Review overlay (diffIds) is a passive highlight — it must NOT
  // pan/zoom, or toggling Review while in Domain/Overview keeps yanking the view
  // to the changed files.
  const focusIds = useMemo(() => impactIds ?? tourIds ?? searchIds ?? null, [impactIds, tourIds, searchIds]);
  // Deep Dive — whole-graph stats for the insights overlay.
  const stats = useMemo(() => (graph && showInsights ? atlasProjectStats(graph) : null), [graph, showInsights]);
  const reviewReach = useMemo(() => (
    showDiff && changedCount && graph ? atlasImpactOf(graph, nodeChanges.keys()).dependents.length : 0
  ), [showDiff, changedCount, graph, nodeChanges]);

  const containerW = dimensions?.width ?? 1180;
  const containerH = dimensions?.height ?? 800;

  const getDynamicMaxWidth = (cardCount: number, cardW: number, cardH: number, nodesep: number, ranksep: number) => {
    const maxPossibleW = Math.max(cardW, Math.min(1080, containerW - 64));
    if (cardCount <= 1) return maxPossibleW;
    const cellW = cardW + nodesep;
    const cellH = cardH + ranksep;
    const totalArea = cardCount * cellW * cellH;
    const aspect = Math.max(0.7, Math.min(1.5, containerW / Math.max(1, containerH)));
    const targetW = Math.sqrt(totalArea * aspect);
    return Math.max(cardW, Math.min(maxPossibleW, targetW));
  };

  // ---- model per mode ----
  // Overview caps to the biggest layers + an "Other" rollup so very large repos
  // stay legible. Domain keeps the full set (atlasOverviewModel's default).
  const overview = useMemo(() => (graph && effMode === "overview" ? atlasOverviewModel(graph, 14) : null), [graph, effMode]);
  const domain = useMemo(() => (graph && effMode === "domain" ? atlasDomainModel(graph) : null), [graph, effMode]);

  const structural = useMemo(() => {
    if (!graph || effMode !== "structural") return null;
    const catScope = new Set(
      graph.nodes.filter((n) => (!scope || scope.has(n.id)) && (!n.category || !disabledCats.has(n.category))).map((n) => n.id),
    );
    const groups = atlasGrouping(graph, catScope);
    return {
      layout: atlasGroupedLayout(groups, {
        containerWidth: containerW,
        containerHeight: containerH,
        maxCols: 4,
      }),
      visible: catScope
    };
  }, [graph, effMode, scope, disabledCats, containerW, containerH]);

  // ---- React Flow nodes/edges ----
  const base = useMemo<{ rfNodes: Node[]; rfEdges: Edge[] }>(() => {
    if (!graph) return { rfNodes: [], rfEdges: [] };
    if (effMode === "overview" && overview) {
      const cardW = 268;
      const cardH = 152;
      const nodesep = 44;
      const ranksep = 84;
      const maxWidth = getDynamicMaxWidth(overview.cards.length, cardW, cardH, nodesep, ranksep);
      const fallbackCols = Math.max(1, Math.floor((maxWidth + nodesep) / (cardW + nodesep)));
      const pos = layeredLayout(overview.cards.map((c) => ({ id: c.id, width: cardW, height: cardH })), overview.edges, { maxWidth, nodesep, ranksep });
      const nodes: Node[] = overview.cards.map((c, i) => ({
        id: c.id,
        type: "atlasLayer",
        position: pos.get(c.id) ?? { x: (i % fallbackCols) * (cardW + nodesep), y: Math.floor(i / fallbackCols) * (cardH + ranksep) },
        data: {
          name: c.name, description: c.description, fileCount: c.fileCount, complexity: c.complexity,
          changed: showDiff ? c.nodeIds.filter((id) => nodeChanges.has(id)).length : 0,
        },
        style: { width: cardW },
      }));
      const edges: Edge[] = overview.edges.map((e, i) => ({
        id: `oe${i}`, source: e.source, target: e.target, type: "smoothstep",
        style: { stroke: "var(--border-strong)", strokeWidth: 1 }, label: e.weight > 1 ? String(e.weight) : undefined,
      }));
      return { rfNodes: nodes, rfEdges: edges };
    }
    if (effMode === "domain" && domain) {
      const cardW = 264;
      const cardH = 168;
      const nodesep = 48;
      const ranksep = 90;
      const maxWidth = getDynamicMaxWidth(domain.cards.length, cardW, cardH, nodesep, ranksep);
      const fallbackCols = Math.max(1, Math.floor((maxWidth + nodesep) / (cardW + nodesep)));
      const pos = layeredLayout(domain.cards.map((c) => ({ id: c.id, width: cardW, height: cardH })), domain.edges, { maxWidth, nodesep, ranksep });
      const nodes: Node[] = domain.cards.map((c, i) => ({
        id: c.id, type: "atlasDomain",
        position: pos.get(c.id) ?? { x: (i % fallbackCols) * (cardW + nodesep), y: Math.floor(i / fallbackCols) * (cardH + ranksep) },
        data: { name: c.name, description: c.description, entities: c.entities, flows: c.flows },
        style: { width: cardW },
      }));
      // Relationship edges between capabilities: labelled with the LLM relationship
      // verb when the graph is enriched (e.g. "calls", "reads from"), else the
      // import count. Width/opacity track how many imports cross the boundary.
      const maxW = Math.max(1, ...domain.edges.map((e) => e.weight));
      const edges: Edge[] = domain.edges.map((e, i) => ({
        id: `de${i}`, source: e.source, target: e.target, type: "smoothstep", animated: true,
        label: e.label ?? `${e.weight}`,
        labelStyle: { fill: "var(--text-dim)", fontSize: 9 },
        labelBgStyle: { fill: "var(--surface)" },
        labelBgPadding: [3, 1] as [number, number],
        style: { stroke: "var(--accent)", strokeOpacity: 0.45 + 0.45 * (e.weight / maxW), strokeWidth: 1 + 1.5 * (e.weight / maxW) },
      }));
      return { rfNodes: nodes, rfEdges: edges };
    }
    if (effMode === "services" && serviceModel) {
      const cardW = 230;
      const cardH = 132;
      const nodesep = 40;
      const ranksep = 82;
      const maxWidth = getDynamicMaxWidth(serviceModel.cards.length, cardW, cardH, nodesep, ranksep);
      const fallbackCols = Math.max(1, Math.floor((maxWidth + nodesep) / (cardW + nodesep)));
      const outC = new Map<string, number>();
      const inC = new Map<string, number>();
      for (const e of serviceModel.edges) {
        outC.set(e.source, (outC.get(e.source) ?? 0) + 1);
        inC.set(e.target, (inC.get(e.target) ?? 0) + 1);
      }
      const pos = layeredLayout(serviceModel.cards.map((c) => ({ id: c.id, width: cardW, height: cardH })), serviceModel.edges, { maxWidth, nodesep, ranksep });
      const nodes: Node[] = serviceModel.cards.map((c, i) => ({
        id: c.id, type: "atlasService",
        position: pos.get(c.id) ?? { x: (i % fallbackCols) * (cardW + nodesep), y: Math.floor(i / fallbackCols) * (cardH + ranksep) },
        data: { module: c.module, portPath: c.portPath, portNodeId: c.portNodeId, fileCount: c.fileCount, dependsOn: outC.get(c.id) ?? 0, dependedOnBy: inC.get(c.id) ?? 0 },
        style: { width: cardW },
      }));
      const maxW = Math.max(1, ...serviceModel.edges.map((e) => e.weight));
      const edges: Edge[] = serviceModel.edges.map((e, i) => ({
        id: `sve${i}`, source: e.source, target: e.target, type: "smoothstep", animated: true,
        style: { stroke: "var(--accent)", strokeOpacity: 0.4 + 0.5 * (e.weight / maxW), strokeWidth: 1 + 1.5 * (e.weight / maxW) },
      }));
      return { rfNodes: nodes, rfEdges: edges };
    }
    if (effMode === "structural" && structural) {
      const { layout, visible } = structural;
      const changedPerGroup = new Map<string, number>();
      if (showDiff) for (const id of nodeChanges.keys()) {
        const g = layout.groupOf.get(id);
        if (g) changedPerGroup.set(g, (changedPerGroup.get(g) ?? 0) + 1);
      }
      const groupNodes: Node[] = layout.groups.map((b) => ({
        id: b.id, type: "atlasGroup", position: { x: b.x, y: b.y },
        data: { label: b.label, count: b.count, changed: changedPerGroup.get(b.id) ?? 0 },
        style: { width: b.width, height: b.height }, selectable: false, draggable: false, zIndex: 0,
      }));
      const fileNodes: Node[] = [];
      for (const [id, pos] of layout.positions) {
        const n = byId.get(id);
        if (!n) continue;
        fileNodes.push({
          id, type: "atlasFile", parentId: layout.groupOf.get(id), extent: "parent", position: pos,
          data: { label: n.name, color: fileColor(n) },
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
  }, [graph, effMode, overview, domain, structural, serviceModel, byId, showDiff, nodeChanges, containerW, containerH]);

  const decoratedBase = useMemo<{ rfNodes: Node[]; rfEdges: Edge[] }>(() => {
    if (effMode !== "structural") return base;
    if (!spotlight && !selected && !showDiff) return base;
    return {
      rfNodes: base.rfNodes.map((n) => {
        if (n.type !== "atlasFile") return n;
        return {
          ...n,
          data: {
            ...n.data,
            dim: spotlight ? !spotlight.has(n.id) : false,
            hot: !!spotlight?.has(n.id),
            selected: selected === n.id,
            change: showDiff ? nodeChanges.get(n.id) : undefined,
          },
        };
      }),
      rfEdges: base.rfEdges,
    };
  }, [base, effMode, spotlight, selected, showDiff, nodeChanges]);

  // CLICK HIGHLIGHT — clicking a node lights up its direct connections (edges
  // brighten + animate, the node and its neighbours stay full opacity) and fades
  // everything else, so you can see "what links to what". Driven by CLICK, not
  // hover: hover recomputed this on every mousemove, which flashed the canvas and
  // lagged large graphs. A cheap restyle ON TOP of the base layout (no re-layout).
  const { rfNodes, rfEdges } = useMemo<{ rfNodes: Node[]; rfEdges: Edge[] }>(() => {
    // Pulse the tour step's nodes (CSS keyframe) so the eye follows the walk.
    const pulse = tourStep != null ? tourIds : null;
    if (!highlightNode && (!pulse || pulse.size === 0)) return decoratedBase;

    const connected = new Set<string>();
    if (highlightNode) {
      connected.add(highlightNode);
      for (const e of decoratedBase.rfEdges) {
        if (e.source === highlightNode) connected.add(e.target);
        if (e.target === highlightNode) connected.add(e.source);
      }
    }
    const rfNodes = decoratedBase.rfNodes.map((n) => {
      let nn: Node = n;
      if (pulse?.has(n.id)) nn = { ...nn, className: [nn.className, "atlas-tour-pulse"].filter(Boolean).join(" ") };
      if (highlightNode) {
        if (n.id === highlightNode) nn = { ...nn, style: { ...nn.style, boxShadow: "0 0 0 1.5px var(--accent), 0 0 22px rgba(124,147,255,0.5)", borderRadius: 10 } };
        else if (!(n.type === "atlasGroup" || connected.has(n.id))) nn = { ...nn, style: { ...nn.style, opacity: 0.3 } };
      }
      return nn;
    });
    const rfEdges = highlightNode
      ? decoratedBase.rfEdges.map((e) => {
          const on = e.source === highlightNode || e.target === highlightNode;
          return { ...e, animated: on, style: { ...e.style, opacity: on ? 1 : 0.1, strokeWidth: on ? Math.max(2, Number(e.style?.strokeWidth ?? 1) + 1) : (e.style?.strokeWidth ?? 1) } };
        })
      : decoratedBase.rfEdges;
    return { rfNodes, rfEdges };
  }, [decoratedBase, highlightNode, tourStep, tourIds]);

  const renderedNodeIds = useMemo(() => new Set(rfNodes.map((n) => n.id)), [rfNodes]);

  // fit to an INTENTIONAL focus (impact click / tour / search) only — never the
  // passive Review highlight (see focusIds). Guard on rendered nodes so we don't
  // try to fit ids that aren't in the current mode's node set.
  useEffect(() => {
    if (!rfRef.current || !focusIds || focusIds.size === 0) return;
    const present = [...focusIds].filter((id) => renderedNodeIds.has(id));
    if (present.length === 0) return;
    rfRef.current.fitView({ nodes: present.map((id) => ({ id })), duration: 600, padding: 0.5, maxZoom: 1.2 });
  }, [focusIds, renderedNodeIds]);

  // re-fit when the mode/drill/filter changes the whole layout — AND when the
  // graph itself first loads (cold app open) or is rebuilt/enriched. Without the
  // `graph`/node-count dep the canvas stayed blank on open until you toggled a
  // mode (the `fitView` prop only fits the initial, often-empty, node set). A
  // short timeout lets React Flow mount the new nodes before we centre them.
  useEffect(() => {
    if (!rfRef.current || rfNodes.length === 0) return;
    const t = setTimeout(() => rfRef.current?.fitView({ duration: 300, padding: 0.2 }), 90);
    return () => clearTimeout(t);
  }, [effMode, drill, disabledCats, graph, rfNodes.length, showInsights]);

  // Esc: leave drill → overview, else clear selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (impactNode) setImpactNode(null);
      else if (drill) { setDrill(null); setMode("overview"); }
      else if (selected) setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drill, selected, impactNode]);

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
        {hasLayers || hasServices ? (
          <div className="atlas-modes">
            {hasLayers ? <button className={`atlas-mode${effMode === "overview" ? " on" : ""}`} onClick={() => { setMode("overview"); setDrill(null); }}>Overview</button> : null}
            {hasLayers ? <button className={`atlas-mode${effMode === "structural" ? " on" : ""}`} onClick={() => setMode("structural")}>Structural</button> : null}
            {hasLayers ? <button className={`atlas-mode${effMode === "domain" ? " on" : ""}`} onClick={() => { setMode("domain"); setDrill(null); }}>Domain</button> : null}
            {hasServices ? <button className={`atlas-mode${effMode === "services" ? " on" : ""}`} onClick={() => { setMode("services"); setDrill(null); }} title="The decomposed service architecture — every module's typed port, wired by cross-module imports">Services</button> : null}
          </div>
        ) : null}
        {/* Project name lives in the breadcrumb below — not duplicated here. */}
        {enrichedCount ? <span className="atlas-count atlas-enriched" title={`${enrichedCount} files summarised`}>{graph.layers.length} layers · {graph.tour.length} tour{graph.layerEdges?.length ? ` · ${graph.layerEdges.length} links` : ""}</span> : null}
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
        <button className={`btn atlas-review-btn${showDiff ? " primary" : ""}`} disabled={busy} onClick={() => setShowDiff((v) => !v)} title="Highlight uncommitted changes — review AI edits before commit">
          <Icon name="diff" size={12} />{showDiff ? "Reviewing" : "Review"}{changedCount ? <span className="atlas-review-badge">{changedCount}</span> : null}
        </button>
        <button className={`btn${showInsights ? " primary" : ""}`} disabled={busy} onClick={() => setShowInsights((v) => !v)} title="Project insights — counts, languages, frameworks, hotspots">Deep Dive</button>
        {graph.tour.length ? <button className="btn" disabled={busy} onClick={() => { setSelected(null); setTourStep(tourStep == null ? 0 : null); }} title="Walk a guided tour">{tourStep == null ? "Tour" : "Exit tour"}</button> : null}
        {onEnrich ? <button className="btn" disabled={busy} onClick={onEnrich} title="Add LLM summaries, layers, and a guided tour">{enriching ? "Enriching…" : enrichedCount ? "Re-enrich" : "Enrich"}</button> : null}
        <button className="btn" disabled={busy} onClick={onBuild} title="Rebuild from the current code">{building ? "Building…" : "Rebuild"}</button>
      </div>

      <div className="atlas-breadcrumb">
        <button className="atlas-crumb" onClick={() => { setMode(hasLayers ? "overview" : "structural"); setDrill(null); }}>{graph.project.name}</button>
        {drillName ? <><span className="atlas-crumb-sep">›</span><span className="atlas-crumb cur">{drillName}</span><span className="atlas-crumb-esc">Esc to go back</span></> : <span className="atlas-crumb-mode">{effMode === "overview" ? "Overview" : effMode === "domain" ? "Domain" : effMode === "services" ? "Services" : "Structural"}</span>}
      </div>

      {showDiff && changedCount ? (
        <div className="atlas-review-banner">
          <span><strong>{changedCount}</strong> changed file{changedCount === 1 ? "" : "s"}{reviewReach ? <> · affects <strong>{reviewReach}</strong> downstream</> : null}{untestedChanged ? <> · <strong className="atlas-untested">{untestedChanged} untested</strong></> : null} — review before commit</span>
          <span className="atlas-review-legend">
            <span className="lg added">added</span>
            <span className="lg modified">modified</span>
            <span className="lg untracked">new</span>
          </span>
        </div>
      ) : null}

      <div className="atlas-canvas" ref={canvasRef}>
        <div className="atlas-rf">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={ATLAS_NODE_TYPES}
          fitView
          minZoom={0.04}
          maxZoom={2.5}
          // PERF (large codebases) — only mount nodes/edges currently in the
          // viewport; off-screen ones are skipped, so a structural map with
          // thousands of file nodes stays responsive when panning/zooming.
          onlyRenderVisibleElements
          proOptions={{ hideAttribution: true }}
          onInit={(inst) => { rfRef.current = inst; }}
          onNodeClick={(_e, n) => {
            if (n.type === "atlasGroup") return;
            // Single click highlights ANY node's connections (drill / open is on
            // double-click). Replaces hover-highlight, which recomputed on every
            // mousemove — the flashing + lag on large graphs.
            setHighlightNode((cur) => (cur === n.id ? null : n.id));
            if (n.type === "atlasService") {
              const portId = (n.data as { portNodeId?: string })?.portNodeId;
              if (portId) { setSelected(portId); onSelectNode?.(portId, byId.get(portId)?.filePath); }
              return;
            }
            if (n.type === "atlasFile") {
              setSelected(n.id);
              onSelectNode?.(n.id, byId.get(n.id)?.filePath);
            }
          }}
          onNodeDoubleClick={(_e, n) => {
            // Double click is the drill / open action.
            if (n.type === "atlasLayer" || n.type === "atlasDomain") { setHighlightNode(null); setDrill(n.id); setMode("structural"); return; }
            const fp = byId.get(n.id)?.filePath;
            if (n.type === "atlasFile" && fp) onOpenFile?.(fp);
          }}
          onPaneClick={() => { setSelected(null); setImpactNode(null); setHighlightNode(null); }}
        >
          <Background color="var(--border)" gap={24} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => {
            if (n.type === "atlasGroup") return "transparent";
            const gn = byId.get(n.id);
            return gn ? fileColor(gn) : "var(--accent)";
          }} maskColor="rgba(0,0,0,0.55)"
            // Compact: the default 200×150 swallowed the narrow side panel.
            style={{ width: 124, height: 86, background: "var(--surface)", border: "1px solid var(--border)" }} />
        </ReactFlow>
        </div>

        {showInsights && stats ? (
          <div className="atlas-insights">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <strong style={{ fontSize: 13 }}>Deep Dive</strong>
              <button className="atlas-detail-x" onClick={() => setShowInsights(false)} aria-label="Close insights" title="Close"><Icon name="close" size={11} /></button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 14 }}>
              {([["Nodes", stats.nodes], ["Edges", stats.edges], ["Layers", stats.layers], ["Files", stats.files]] as Array<[string, number]>).map(([k, v]) => (
                <div key={k} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", borderRadius: 6, padding: "7px 9px" }}>
                  <div style={{ fontSize: 17, fontWeight: 600 }}>{v}</div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4 }}>{k}</div>
                </div>
              ))}
            </div>
            {([
              { title: "File types", items: stats.byCategory.map((c) => ({ key: c.key, count: c.count, color: ATLAS_CATEGORY_COLORS[c.key as AtlasFileCategory] })) },
              { title: "Languages", items: stats.languages.map((l) => ({ key: l.key, count: l.count, color: "var(--accent)" })) },
              { title: "Complexity", items: stats.byComplexity.map((c) => ({ key: c.key, count: c.count, color: "var(--text-dim)" })) },
            ] as Array<{ title: string; items: Array<{ key: string; count: number; color?: string }> }>).filter((s) => s.items.length).map((sec) => {
              const max = Math.max(1, ...sec.items.map((i) => i.count));
              return (
                <div key={sec.title} style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{sec.title}</div>
                  {sec.items.map((it) => (
                    <div key={it.key} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: it.color ?? "var(--accent)", flex: "0 0 auto" }} />
                      <span style={{ fontSize: 11, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.key}</span>
                      <span style={{ position: "relative", width: 56, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.06)" }}>
                        <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(it.count / max) * 100}%`, borderRadius: 2, background: it.color ?? "var(--accent)", opacity: 0.7 }} />
                      </span>
                      <span style={{ fontSize: 10, color: "var(--text-dim)", width: 26, textAlign: "right" }}>{it.count}</span>
                    </div>
                  ))}
                </div>
              );
            })}
            {stats.frameworks.length ? (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Frameworks</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {stats.frameworks.map((f) => <span key={f} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 10, background: "rgba(255,255,255,0.05)", border: "1px solid var(--border)" }}>{f}</span>)}
                </div>
              </div>
            ) : null}
            {stats.topConnected.length ? (
              <div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Most connected</div>
                {stats.topConnected.map((t) => (
                  <button key={t.id} onClick={() => { setSelected(t.id); onSelectNode?.(t.id, byId.get(t.id)?.filePath); }} style={{ display: "flex", justifyContent: "space-between", width: "100%", gap: 6, background: "none", border: "none", color: "inherit", padding: "3px 0", cursor: "pointer", textAlign: "left" }} title={t.name}>
                    <span style={{ fontSize: 11, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
                    <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t.degree} links</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {selected ? (() => {
          const selPath = byId.get(selected)?.filePath;
          return (
            <AtlasDetail
              graph={graph} nodeId={selected}
              onClose={() => { setSelected(null); setImpactNode(null); }}
              onOpenFile={onOpenFile}
              changeKind={nodeChanges.get(selected)}
              impactActive={impactNode === selected}
              onShowImpact={(id) => setImpactNode((cur) => (cur === id ? null : id))}
              assessment={selPath ? assessments?.[selPath] : undefined}
              assessing={!!selPath && assessing === selPath}
              onAssess={onAssess && selPath ? () => onAssess(selPath) : undefined}
              untested={uncovered.has(selected)}
            />
          );
        })() : null}

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
