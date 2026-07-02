/**
 * Atlas panel — the interactive codebase knowledge graph (ATLAS-5/10).
 *
 * Two reading altitudes:
 *  - Overview   — architectural LAYER cards (enriched graphs); click to drill in.
 *  - Structural — files clustered into titled containers (by layer, else dir),
 *                 coloured by category, with import edges; the real map.
 * Plus a node detail card, a guided tour, search spotlight, category filters,
 * a drill breadcrumb, and open-in-editor. Styling tracks the app theme.
 *
 * This file is a thin composition shell: the derived view-model + effects live
 * in {@link useAtlasGraph}, the per-mode React Flow builders in {@link ./AtlasPanel/atlasModel},
 * and the Deep Dive / tour overlays in their own sibling components.
 */
import React from "react";
import { ReactFlow, Background, Controls, ControlButton, MiniMap } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AtlasGraph } from "@kinqs/brainrouter-types";
import type { AtlasChangeAssessment } from "../lib/atlas/atlasView.js";
import { ATLAS_CATEGORY_COLORS } from "../lib/atlas/atlasView.js";
import { ATLAS_NODE_TYPES } from "./AtlasNodes.js";
import { AtlasDetail } from "./AtlasDetail.js";
import { Icon } from "../icons.js";
import { useAtlasGraph } from "./AtlasPanel/useAtlasGraph.js";
import { fileColor } from "./AtlasPanel/atlasModel.js";
import { AtlasInsights } from "./AtlasPanel/AtlasInsights.js";
import { AtlasTour } from "./AtlasPanel/AtlasTour.js";

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

export function AtlasPanel({ graph, building, enriching = false, onBuild, onEnrich, onSelectNode, onOpenFile, onLoad, changedFiles, assessments, assessing, onAssess }: AtlasPanelProps): React.ReactElement {
  const a = useAtlasGraph({ graph, changedFiles, onLoad });
  const {
    selected, setSelected, tourStep, setTourStep, query, setQuery, mode, setMode, drill, setDrill,
    disabledCats, showDiff, setShowDiff, impactNode, setImpactNode, highlightNode, setHighlightNode,
    showInsights, setShowInsights, rfRef, canvasRef, byId, nodeChanges, changedCount, uncovered,
    untestedChanged, hasServices, hasLayers, effMode, presentCats, searchIds, stats, reviewReach,
    structural, rfNodes, rfEdges, toggleCat,
  } = a;

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
        {effMode === "structural" && structural && structural.hidden > 0
          ? <span className="atlas-crumb-note" title={hasLayers ? "Open a layer (Overview) or double-click a group to see every file" : "Double-click a group to drill in and see every file"}>+{structural.hidden} more {structural.hidden === 1 ? "file" : "files"} not shown</span>
          : null}
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
          <Controls showInteractive={false} showFitView={false}>
            {/* Custom fit button: the default fits only on-screen (measured)
                nodes, which is a no-op here because off-screen nodes are
                virtualized away — pass the explicit id list so it frames all. */}
            <ControlButton title="Fit view" aria-label="Fit view"
              onClick={() => rfRef.current?.fitView({ nodes: rfNodes.map((n) => ({ id: n.id })), padding: 0.2, duration: 300, maxZoom: 1.2 })}>
              <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true"><path d="M2 2h3v1.4H3.4V5H2V2zm7 0h3v3h-1.4V3.4H9V2zM2 9h1.4v1.6H5V12H2V9zm8.6 0H12v3H9v-1.4h1.6V9z" /></svg>
            </ControlButton>
          </Controls>
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
          <AtlasInsights
            stats={stats}
            onClose={() => setShowInsights(false)}
            onSelect={(id) => { setSelected(id); onSelectNode?.(id, byId.get(id)?.filePath); }}
          />
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
          <AtlasTour graph={graph} tourStep={tourStep} setTourStep={setTourStep} />
        ) : null}
      </div>
    </div>
  );
}
