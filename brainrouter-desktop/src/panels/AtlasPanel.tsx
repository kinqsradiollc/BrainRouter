/**
 * Atlas panel (ATLAS-5) — the interactive codebase knowledge graph.
 *
 * Renders the stored AtlasGraph as a pan/zoom force-directed graph: file-level
 * nodes (coloured by type), import edges, a minimap + controls. Empty state
 * offers a one-click build. Node detail / search / tour / code-view land in the
 * next slices. Styling tracks the app theme via CSS variables (no external
 * palette).
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AtlasGraph, AtlasNodeType } from "@kinqs/brainrouter-types";
import { atlasLayout, atlasNodeColor, atlasViewModel } from "../lib/atlas/atlasView.js";
import { AtlasDetail } from "./AtlasDetail.js";
import { Icon } from "../icons.js";

export interface AtlasPanelProps {
  graph: AtlasGraph | null;
  building: boolean;
  /** True while LLM enrichment is running. */
  enriching?: boolean;
  onBuild: () => void;
  /** Run LLM enrichment (summaries, layers, tour) over the current graph. */
  onEnrich?: () => void;
  /** Selecting a node bubbles up (detail panel + code view wire in later slices). */
  onSelectNode?: (nodeId: string, filePath?: string) => void;
  /** Called once on open to lazily load the stored graph if not already present. */
  onLoad?: () => void;
}

export function AtlasPanel({ graph, building, enriching = false, onBuild, onEnrich, onSelectNode, onLoad }: AtlasPanelProps): React.ReactElement {
  const [selected, setSelected] = useState<string | null>(null);
  const [tourStep, setTourStep] = useState<number | null>(null); // null = not touring
  const rfRef = useRef<ReactFlowInstance | null>(null);

  useEffect(() => {
    if (!graph) onLoad?.();
    // load once on open; subsequent opens reuse the App-held graph
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The node ids highlighted by the current tour step (null = not touring).
  const tourIds = useMemo(() => {
    if (tourStep == null || !graph) return null;
    const step = graph.tour[tourStep];
    return step && step.nodeIds.length ? new Set(step.nodeIds) : new Set<string>();
  }, [tourStep, graph]);

  const view = useMemo(() => {
    if (!graph) return null;
    const vm = atlasViewModel(graph);
    const pos = atlasLayout(vm);
    const types = new Map(vm.nodes.map((n) => [n.id, n.type] as const));
    const nodes: Node[] = vm.nodes.map((n) => {
      const p = pos.get(n.id) ?? { x: 0, y: 0 };
      const color = atlasNodeColor(n.type);
      return {
        id: n.id,
        position: p,
        data: { label: n.name },
        style: {
          background: "var(--raised)",
          color: "var(--text)",
          border: `2px solid ${color}`,
          borderRadius: 9,
          fontSize: 10.5,
          padding: "4px 9px",
          width: "auto",
          maxWidth: 200,
          whiteSpace: "nowrap",
        },
      };
    });
    const edges: Edge[] = vm.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.source,
      target: e.target,
      style: { stroke: "var(--border-strong)", strokeWidth: 1 },
    }));
    return { nodes, edges, shown: vm.shown, total: vm.total, types };
  }, [graph]);

  // While touring, spotlight the step's nodes and dim the rest.
  const displayNodes = useMemo(() => {
    const base = view?.nodes ?? [];
    if (!tourIds) return base;
    return base.map((n) => ({
      ...n,
      style: {
        ...n.style,
        opacity: tourIds.has(n.id) ? 1 : 0.16,
        boxShadow: tourIds.has(n.id) ? "0 0 0 3px var(--accent)" : undefined,
      },
    }));
  }, [view, tourIds]);

  // Pan/zoom to the current step's nodes when the step changes.
  useEffect(() => {
    if (tourStep == null || !tourIds || !rfRef.current || tourIds.size === 0) return;
    rfRef.current.fitView({ nodes: [...tourIds].map((id) => ({ id })), duration: 500, padding: 0.45 });
  }, [tourStep, tourIds]);

  if (!graph) {
    return (
      <div className="atlas-empty">
        <Icon name="atlas" size={40} />
        <div className="atlas-empty-title">No atlas yet</div>
        <div className="atlas-empty-desc">Build an interactive knowledge graph of this workspace — every file, function and class, and how they connect.</div>
        <button className="btn primary" disabled={building} onClick={onBuild}>
          {building ? "Building…" : "Build atlas"}
        </button>
      </div>
    );
  }

  const v = view!;
  const enrichedCount = graph.nodes.filter((n) => n.summary).length;
  const busy = building || enriching;
  return (
    <div className="atlas-panel">
      <div className="atlas-toolbar">
        <span className="atlas-proj">{graph.project.name}</span>
        <span className="atlas-count">{v.shown}{v.total > v.shown ? ` of ${v.total}` : ""} files</span>
        {enrichedCount ? (
          <span className="atlas-count atlas-enriched" title={`${enrichedCount} files summarised`}>
            · {graph.layers.length} layers · {graph.tour.length} tour
          </span>
        ) : null}
        <span className="atlas-spacer" />
        {graph.tour.length ? (
          <button className="btn" disabled={busy} onClick={() => { setSelected(null); setTourStep(tourStep == null ? 0 : null); }} title="Walk a guided tour through the codebase">
            {tourStep == null ? "Tour" : "Exit tour"}
          </button>
        ) : null}
        {onEnrich ? (
          <button className="btn" disabled={busy} onClick={onEnrich} title="Add LLM summaries, architectural layers, and a guided tour">
            {enriching ? "Enriching…" : enrichedCount ? "Re-enrich" : "Enrich"}
          </button>
        ) : null}
        <button className="btn" disabled={busy} onClick={onBuild} title="Rebuild the atlas from the current code">
          {building ? "Building…" : "Rebuild"}
        </button>
      </div>
      <div className="atlas-canvas">
        <ReactFlow
          nodes={displayNodes}
          edges={v.edges}
          fitView
          minZoom={0.05}
          maxZoom={2.5}
          nodesDraggable
          proOptions={{ hideAttribution: true }}
          onInit={(inst) => { rfRef.current = inst; }}
          onNodeClick={(_e, n) => {
            setSelected(n.id);
            onSelectNode?.(n.id, graph.nodes.find((gn) => gn.id === n.id)?.filePath);
          }}
          onPaneClick={() => setSelected(null)}
        >
          <Background color="var(--border)" gap={22} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => atlasNodeColor((v.types.get(n.id) ?? "file") as AtlasNodeType)}
            maskColor="rgba(0,0,0,0.55)"
            style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
          />
        </ReactFlow>
        {selected ? <AtlasDetail graph={graph} nodeId={selected} onClose={() => setSelected(null)} /> : null}
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
