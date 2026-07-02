/**
 * Atlas panel — derived-state hook.
 *
 * Owns all the memoised view-model derivation (per-mode models, spotlight sets,
 * React Flow nodes/edges) and the fit/keyboard/resize effects, so the panel
 * component is left as thin composition. Returns everything the render needs.
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import type { AtlasFileCategory, AtlasGraph } from "@kinqs/brainrouter-types";
import {
  atlasOverviewModel, atlasDomainModel, atlasServiceModel, atlasSearchMatches,
  atlasChangeMap, atlasNodeChanges, atlasImpact, atlasImpactOf, atlasUncoveredFiles, atlasProjectStats, ATLAS_FILE_CATEGORIES,
  type AtlasChangeKind,
} from "../../lib/atlas/atlasView.js";
import { buildRfModel, buildStructuralModel, type Mode } from "./atlasModel.js";

export interface UseAtlasGraphArgs {
  graph: AtlasGraph | null;
  changedFiles?: ReadonlyArray<{ path: string; status: string }>;
  onLoad?: () => void;
}

export function useAtlasGraph(args: UseAtlasGraphArgs) {
  const { graph, changedFiles, onLoad } = args;

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

  // ---- model per mode ----
  // Overview caps to the biggest layers + an "Other" rollup so very large repos
  // stay legible. Domain keeps the full set (atlasOverviewModel's default).
  const overview = useMemo(() => (graph && effMode === "overview" ? atlasOverviewModel(graph, 14) : null), [graph, effMode]);
  const domain = useMemo(() => (graph && effMode === "domain" ? atlasDomainModel(graph) : null), [graph, effMode]);

  const structural = useMemo(() => {
    if (!graph || effMode !== "structural") return null;
    return buildStructuralModel(graph, scope, disabledCats, containerW, containerH);
  }, [graph, effMode, scope, disabledCats, containerW, containerH]);

  // ---- React Flow nodes/edges ----
  const base = useMemo<{ rfNodes: Node[]; rfEdges: Edge[] }>(() => {
    if (!graph) return { rfNodes: [], rfEdges: [] };
    return buildRfModel({ graph, effMode, overview, domain, serviceModel, structural, byId, showDiff, nodeChanges, containerW, containerH });
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

  const toggleCat = (c: AtlasFileCategory): void => {
    setDisabledCats((prev) => {
      const next = new Set(prev);
      next.has(c) ? next.delete(c) : next.add(c);
      return next;
    });
  };

  return {
    // state
    selected, setSelected,
    tourStep, setTourStep,
    query, setQuery,
    mode, setMode,
    drill, setDrill,
    disabledCats,
    showDiff, setShowDiff,
    impactNode, setImpactNode,
    highlightNode, setHighlightNode,
    showInsights, setShowInsights,
    rfRef,
    canvasRef,
    // derived
    byId,
    nodeChanges,
    changedCount,
    uncovered,
    untestedChanged,
    hasServices,
    hasLayers,
    effMode,
    presentCats,
    searchIds,
    stats,
    reviewReach,
    structural,
    rfNodes,
    rfEdges,
    // handlers
    toggleCat,
  };
}
