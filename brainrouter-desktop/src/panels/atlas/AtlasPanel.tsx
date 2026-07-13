/**
 * Atlas panel — the interactive codebase knowledge graph (ATLAS-5/10).
 *
 * Reading altitudes:
 *  - Overview   — architectural LAYER cards (enriched graphs); click to drill in.
 *  - Structural — files clustered into titled containers (by layer, else dir),
 *                 coloured by category, with import edges; the real map.
 *  - Domain / Services — capability + service-port views.
 *  - Screens    — the UI-TEST fusion map: a generated screen/element interaction
 *                 map, cross-linked to code, with a Command Layer + user Stories.
 * Plus a node detail card, a guided tour, search spotlight, category filters,
 * a drill breadcrumb, and open-in-editor. Styling tracks the app theme.
 *
 * This file is a thin composition shell: the derived graph view-model + effects
 * live in {@link useAtlasGraph}, the per-mode React Flow builders in
 * {@link ./AtlasPanel/atlasModel}, and the Deep Dive / tour overlays in their own
 * sibling components. The Screens mode's own React-Flow model is built here
 * (below) because it is driven by panel-local state (extract/selection/stories)
 * and overrides the hook's graph nodes when active.
 */
import React, { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls, ControlButton, MiniMap, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { AtlasGraph } from "@kinqs/brainrouter-types";
import type { AtlasChangeAssessment } from "../../lib/atlas/atlasView.js";
import { ATLAS_CATEGORY_COLORS, atlasUiModel, atlasElementColor, atlasGroupedLayout } from "../../lib/atlas/atlasView.js";
import type { UiMap, Story } from "@kinqs/brainrouter-core/uitest";
import { ATLAS_NODE_TYPES } from "./AtlasNodes.js";
import { AtlasDetail } from "./AtlasDetail.js";
import { Icon } from "../../icons.js";
import { useAtlasGraph } from "../AtlasPanel/useAtlasGraph.js";
import { fileColor, type Mode } from "../AtlasPanel/atlasModel.js";
import { AtlasInsights } from "../AtlasPanel/AtlasInsights.js";
import { AtlasTour } from "../AtlasPanel/AtlasTour.js";

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
  /** UI-TEST fusion (Screens mode) — the generated UI map for this workspace. */
  uiMap?: UiMap | null;
  /** Run the extractor. `broad` captures every interactive control (no
   *  data-testid needed); `only` limits to specific screens' source files. */
  onExtractUi?: (opts?: { only?: string[]; broad?: boolean }) => void;
  /** Load the persisted ui-map when the panel opens. */
  onLoadUiMap?: () => void;
  /** Hand a Screens-mode element off to the Browser panel to drive it live. */
  onDriveElement?: (el: { testID: string; action: string; route?: string | null }) => void;
  /** UI Stories (named user journeys) for this workspace + their controls. */
  stories?: Story[];
  onLoadStories?: () => void;
  onSuggestStories?: () => void;
  onRunStory?: (story: Story) => void;
}

export function AtlasPanel({ graph, building, enriching = false, onBuild, onEnrich, onSelectNode, onOpenFile, onLoad, changedFiles, assessments, assessing, onAssess, uiMap, onExtractUi, onLoadUiMap, onDriveElement, stories, onLoadStories, onSuggestStories, onRunStory }: AtlasPanelProps): React.ReactElement {
  const a = useAtlasGraph({ graph, changedFiles, onLoad });
  const {
    selected, setSelected, tourStep, setTourStep, query, setQuery, mode, setMode, drill, setDrill,
    disabledCats, showDiff, setShowDiff, impactNode, setImpactNode, highlightNode, setHighlightNode,
    showInsights, setShowInsights, rfRef, canvasRef, byId, nodeChanges, changedCount, uncovered,
    untestedChanged, hasServices, hasLayers, effMode, presentCats, searchIds, stats, reviewReach,
    structural, rfNodes: graphRfNodes, rfEdges: graphRfEdges, containerW, containerH, toggleCat,
  } = a;

  // --- Screens mode (UI-TEST fusion) — panel-local state ---
  const [selectedScreens, setSelectedScreens] = useState<ReadonlySet<string>>(new Set()); // Screens mode selection
  const [busyUi, setBusyUi] = useState(false); // extract in flight
  const [broadMode, setBroadMode] = useState(true); // Broad (every control) ⇄ Precise (data-testid only)
  const [showCommands, setShowCommands] = useState(false); // Command Layer overlay
  const [copied, setCopied] = useState(false); // "Copy JSON" feedback
  const [viewMenu, setViewMenu] = useState(false); // compact "View ▾" mode dropdown
  const [showStories, setShowStories] = useState(false); // Stories overlay
  const [selectedStory, setSelectedStory] = useState<string | null>(null); // highlighted journey
  const [busyStories, setBusyStories] = useState(false); // suggest in flight

  // Load the persisted UI map + stories when the panel first opens.
  useEffect(() => {
    onLoadUiMap?.();
    onLoadStories?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Screens mode: clear the extract spinner once a fresh map arrives.
  useEffect(() => { setBusyUi(false); }, [uiMap]);
  // Stories: clear the suggest spinner once fresh stories arrive.
  useEffect(() => { setBusyStories(false); }, [stories]);

  // Screens mode (UI-TEST fusion): the generated UI map → screen containers +
  // element leaf nodes. Its own sub-structure, cross-linked to code by filePath.
  const uiModel = useMemo(() => (effMode === "screens" ? atlasUiModel(uiMap ?? null) : null), [effMode, uiMap]);

  // The highlighted story + its resolved node path (screen containers + element
  // nodes, in step order) — drives the journey edges + node glow on the map.
  const activeStory = useMemo(() => (selectedStory ? (stories ?? []).find((s) => s.id === selectedStory) ?? null : null), [selectedStory, stories]);
  const storyPath = useMemo<string[]>(() => {
    if (!activeStory || !uiModel) return [];
    const byTestId = new Map<string, string[]>();
    for (const [nodeId, el] of uiModel.elements) {
      const arr = byTestId.get(el.testID);
      if (arr) arr.push(nodeId); else byTestId.set(el.testID, [nodeId]);
    }
    const seq: string[] = [];
    let cur: string | null = null;
    for (const step of activeStory.steps) {
      if (step.action === "navigate") {
        cur = step.target;
        const sn = `uiscreen:${step.target}`;
        if (uiModel.screens.has(sn)) seq.push(sn);
        continue;
      }
      let id: string | null = null;
      if (cur && uiModel.elements.has(`uiel:${cur}::${step.target}`)) id = `uiel:${cur}::${step.target}`;
      else { const cs = byTestId.get(step.target); id = cs && cs.length ? cs[0] : null; }
      if (id) seq.push(id);
    }
    return seq;
  }, [activeStory, uiModel]);

  // Screens-mode React Flow model — built here (panel-local state) and swapped in
  // for the hook's graph model when Screens is active. Graph modes are untouched.
  const screensModel = useMemo<{ rfNodes: Node[]; rfEdges: Edge[] }>(() => {
    if (effMode !== "screens" || !uiModel || uiModel.groups.length === 0) return { rfNodes: [], rfEdges: [] };
    // Cap the pills drawn per screen so a huge screen (e.g. Settings, 129) stays
    // a legible card instead of a giant tower — the Command Layer view lists all.
    const CAP = 24;
    const storyNodes = new Set(storyPath);
    const forced = new Set(storyPath.filter((id) => id.startsWith("uiel:")));
    // Draw the first CAP pills, plus any the highlighted story references past it,
    // so a journey edge never dangles to an undrawn node.
    const capped = uiModel.groups.map((g) => {
      if (g.nodeIds.length <= CAP) return g;
      const extra = g.nodeIds.slice(CAP).filter((id) => forced.has(id));
      return { ...g, nodeIds: [...g.nodeIds.slice(0, CAP), ...extra] };
    });
    const drawn = new Map(capped.map((g) => [g.id, g.nodeIds.length]));
    const hiddenOf = new Map(uiModel.groups.map((g) => [g.id, Math.max(0, g.nodeIds.length - (drawn.get(g.id) ?? g.nodeIds.length))]));
    const layout = atlasGroupedLayout(capped, {
      containerWidth: containerW, containerHeight: containerH, maxCols: 4, nodeW: 148, nodeH: 30, titleH: 46,
    });
    const screenNodes: Node[] = layout.groups.map((b) => {
      const s = uiModel.screens.get(b.id);
      return {
        id: b.id, type: "atlasScreen", position: { x: b.x, y: b.y },
        data: { title: s?.title ?? b.label, route: s?.route ?? null, count: s?.elementCount ?? b.count, hidden: hiddenOf.get(b.id) ?? 0, selected: selectedScreens.has(b.id), hasFile: !!s?.filePath },
        className: storyNodes.has(b.id) ? "atlas-story-hot" : undefined,
        style: { width: b.width, height: b.height }, draggable: false, zIndex: 0,
      };
    });
    const elementNodes: Node[] = [];
    for (const [id, pos] of layout.positions) {
      const el = uiModel.elements.get(id);
      if (!el) continue;
      elementNodes.push({
        id, type: "atlasElement", parentId: layout.groupOf.get(id), extent: "parent", position: pos,
        data: { label: el.testID, action: el.action, color: atlasElementColor(el.action) },
        className: storyNodes.has(id) ? "atlas-story-hot" : undefined,
      });
    }
    // Journey edges — connect the highlighted story's element nodes in step order.
    const present = new Set(elementNodes.map((n) => n.id));
    const elems = storyPath.filter((id) => id.startsWith("uiel:") && present.has(id));
    const rfEdges: Edge[] = [];
    for (let i = 0; i < elems.length - 1; i++) {
      if (elems[i] === elems[i + 1]) continue;
      rfEdges.push({ id: `story-e${i}`, source: elems[i], target: elems[i + 1], type: "smoothstep", animated: true, zIndex: 10, style: { stroke: "var(--accent)", strokeWidth: 2, opacity: 0.9 } });
    }
    return { rfNodes: [...screenNodes, ...elementNodes], rfEdges };
  }, [effMode, uiModel, storyPath, selectedScreens, containerW, containerH]);

  // In Screens mode the panel renders its own nodes/edges (above); every other
  // mode keeps the hook's graph model verbatim.
  const rfNodes = effMode === "screens" ? screensModel.rfNodes : graphRfNodes;
  const rfEdges = effMode === "screens" ? screensModel.rfEdges : graphRfEdges;

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

  // Views for the compact "View ▾" dropdown (replaces the row of mode tabs).
  const viewOptions: Array<{ mode: Mode; label: string }> = [];
  if (hasLayers) viewOptions.push({ mode: "overview", label: "Overview" }, { mode: "structural", label: "Structural" }, { mode: "domain", label: "Domain" });
  else viewOptions.push({ mode: "structural", label: "Map" });
  if (hasServices) viewOptions.push({ mode: "services", label: "Services" });
  viewOptions.push({ mode: "screens", label: "Screens" });
  const viewLabel = viewOptions.find((o) => o.mode === effMode)?.label ?? "Structural";

  // Command Layer — flatten the UI map into the callable command list (the same
  // shape the agent's ui_* tools consume) and copy it to the clipboard.
  const copyCommands = (): void => {
    if (!uiModel) return;
    const cmds = [...uiModel.elements.values()].map((e) => {
      const s = uiModel.screens.get(e.screenNodeId);
      return { screen: s?.title, route: s?.route ?? null, action: e.action, testID: e.testID, filePath: e.filePath };
    });
    try {
      void navigator.clipboard?.writeText(JSON.stringify(cmds, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className="atlas-panel">
      <div className="atlas-toolbar">
        <div className="atlas-viewsel">
          <button className="atlas-viewsel-btn" onClick={() => setViewMenu((v) => !v)} title="Switch view" aria-haspopup="menu" aria-expanded={viewMenu}>
            {viewLabel}<span className="atlas-viewsel-caret">▾</span>
          </button>
          {viewMenu ? (
            <>
              <div className="atlas-viewsel-backdrop" onClick={() => setViewMenu(false)} />
              <div className="atlas-viewsel-menu" role="menu">
                {viewOptions.map((o) => (
                  <button key={o.mode} role="menuitem" className={`atlas-viewsel-item${effMode === o.mode ? " on" : ""}`} onClick={() => { setMode(o.mode); setDrill(null); setViewMenu(false); }}>{o.label}</button>
                ))}
              </div>
            </>
          ) : null}
        </div>
        {effMode === "screens" ? (
          <div className="atlas-ui-controls">
            <button className="btn primary" disabled={busyUi} onClick={() => { setBusyUi(true); onExtractUi?.({ broad: broadMode }); }} title="Walk this workspace's source and (re)build the whole screen map">{busyUi ? "Extracting…" : "Extract all"}</button>
            <button className="btn" disabled={busyUi || selectedScreens.size === 0} onClick={() => {
              const only = [...selectedScreens].map((id) => uiModel?.screens.get(id)?.filePath).filter((p): p is string => !!p);
              if (only.length) { setBusyUi(true); onExtractUi?.({ only, broad: broadMode }); }
            }} title="Re-extract just the selected screens' source files">Extract selected{selectedScreens.size ? ` (${selectedScreens.size})` : ""}</button>
            <button className={`btn${broadMode ? " primary" : ""}`} onClick={() => setBroadMode((v) => !v)} title={broadMode ? "Broad — captures every interactive control (no data-testid needed). Click for Precise (data-testid only)." : "Precise — data-testid only. Click for Broad (maps the whole app)."}>{broadMode ? "Broad" : "Precise"}</button>
            <button className={`btn${showCommands ? " primary" : ""}`} disabled={!uiModel || uiModel.elementCount === 0} onClick={() => setShowCommands((v) => !v)} title="Command Layer — every screen's tap/type/navigate commands, runnable + exportable"><Icon name="bolt" size={12} /> Command Layer</button>
            <button className={`btn${showStories ? " primary" : ""}`} onClick={() => setShowStories((v) => !v)} title="UI Stories — named user journeys you can run + watch in the Browser panel"><Icon name="play" size={12} /> Stories{stories?.length ? ` (${stories.length})` : ""}</button>
            {uiModel && uiModel.screenCount > 0 ? <span className="atlas-count">{uiModel.screenCount} screens · {uiModel.elementCount} elements</span> : null}
            {uiModel?.degraded ? <span className="atlas-ui-degraded" title="Install the optional 'typescript' peer for AST extraction">degraded — install typescript</span> : null}
          </div>
        ) : null}
        {/* Layer/tour/link counts moved to the breadcrumb below — the toolbar keeps only controls. */}
        {effMode === "structural" && presentCats.length ? (
          <div className="atlas-cats">
            {presentCats.map((c) => (
              <button key={c} className={`atlas-cat${disabledCats.has(c) ? " off" : ""}`} onClick={() => toggleCat(c)} title={`Toggle ${c}`}>
                <span className="atlas-cat-dot" style={{ background: ATLAS_CATEGORY_COLORS[c] }} />{c}
              </button>
            ))}
          </div>
        ) : null}
        {effMode !== "screens" ? (
          <>
            <label className="atlas-search">
              <Icon name="search" size={12} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }} placeholder="Search…" spellCheck={false} />
              {query.trim() ? <span className="atlas-search-count">{searchIds?.size ?? 0}</span> : null}
            </label>
            <span className="atlas-spacer" />
            <div className="atlas-actions">
              <button className={`btn atlas-review-btn${showDiff ? " primary" : ""}`} disabled={busy} onClick={() => setShowDiff((v) => !v)} title="Highlight uncommitted changes — review AI edits before commit">
                <Icon name="diff" size={12} />{showDiff ? "Reviewing" : "Review"}{changedCount ? <span className="atlas-review-badge">{changedCount}</span> : null}
              </button>
              <button className={`btn${showInsights ? " primary" : ""}`} disabled={busy} onClick={() => setShowInsights((v) => !v)} title="Project insights — counts, languages, frameworks, hotspots">Deep Dive</button>
              {graph.tour.length ? <button className="btn" disabled={busy} onClick={() => { setSelected(null); setTourStep(tourStep == null ? 0 : null); }} title="Walk a guided tour">{tourStep == null ? "Tour" : "Exit tour"}</button> : null}
              {onEnrich ? <button className="btn" disabled={busy} onClick={onEnrich} title="Add LLM summaries, layers, and a guided tour">{enriching ? "Enriching…" : enrichedCount ? "Re-enrich" : "Enrich"}</button> : null}
              <button className="btn" disabled={busy} onClick={onBuild} title="Rebuild from the current code">{building ? "Building…" : "Rebuild"}</button>
            </div>
          </>
        ) : <span className="atlas-spacer" />}
      </div>

      <div className="atlas-breadcrumb">
        <button className="atlas-crumb" onClick={() => { setMode(hasLayers ? "overview" : "structural"); setDrill(null); }}>{graph.project.name}</button>
        {drillName ? <><span className="atlas-crumb-sep">›</span><span className="atlas-crumb cur">{drillName}</span><span className="atlas-crumb-esc">Esc to go back</span></> : <span className="atlas-crumb-mode">{effMode === "overview" ? "Overview" : effMode === "domain" ? "Domain" : effMode === "services" ? "Services" : effMode === "screens" ? "Screens" : "Structural"}</span>}
        {effMode === "structural" && structural && structural.hidden > 0
          ? <span className="atlas-crumb-note" title={hasLayers ? "Open a layer (Overview) or double-click a group to see every file" : "Double-click a group to drill in and see every file"}>+{structural.hidden} more {structural.hidden === 1 ? "file" : "files"} not shown</span>
          : null}
        {effMode !== "screens" && enrichedCount ? <span className="atlas-crumb-count" title={`${enrichedCount} files summarised`}>{graph.layers.length} layers · {graph.tour.length} tour{graph.layerEdges?.length ? ` · ${graph.layerEdges.length} links` : ""}</span> : null}
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
            if (n.type === "atlasScreen") {
              // Single-click toggles a screen's selection (for "extract selected").
              setSelectedScreens((prev) => { const next = new Set(prev); next.has(n.id) ? next.delete(n.id) : next.add(n.id); return next; });
              return;
            }
            if (n.type === "atlasElement") return;
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
            if (n.type === "atlasScreen") { const s = uiModel?.screens.get(n.id); if (s?.filePath) onOpenFile?.(s.filePath); return; }
            if (n.type === "atlasElement") {
              const el = uiModel?.elements.get(n.id);
              if (el) onDriveElement?.({ testID: el.testID, action: el.action, route: uiModel?.screens.get(el.screenNodeId)?.route ?? null });
              return;
            }
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

        {effMode === "screens" && (!uiModel || uiModel.screenCount === 0) ? (
          <div className="atlas-ui-empty">
            <Icon name="globe" size={30} />
            <div className="atlas-empty-title">No screen map yet</div>
            <div className="atlas-empty-desc">Extract this workspace's <code>data-testid</code> elements into a screen map the Browser panel and agent can drive.</div>
            <button className="btn primary" disabled={busyUi} onClick={() => { setBusyUi(true); onExtractUi?.({ broad: broadMode }); }}>{busyUi ? "Extracting…" : "Extract all"}</button>
          </div>
        ) : null}

        {showCommands && effMode === "screens" && uiModel && uiModel.elementCount > 0 ? (
          <div className="atlas-commands">
            <div className="atlas-commands-head">
              <strong>Command Layer</strong>
              <span className="atlas-commands-sub">{uiModel.elementCount} commands · {uiModel.screenCount} screens</span>
              <span className="atlas-commands-actions">
                <button className="chip" onClick={copyCommands} title="Copy every command as JSON">{copied ? "Copied ✓" : "Copy JSON"}</button>
                <button className="atlas-detail-x" onClick={() => setShowCommands(false)} aria-label="Close command layer" title="Close"><Icon name="close" size={11} /></button>
              </span>
            </div>
            <div className="atlas-commands-body">
              {[...uiModel.screens.values()].map((s) => {
                const els = [...uiModel.elements.values()].filter((e) => e.screenNodeId === s.nodeId);
                if (!els.length) return null;
                return (
                  <div key={s.nodeId} className="atlas-cmd-screen">
                    <div className="atlas-cmd-screen-head">{s.title}{s.route ? <span className="atlas-cmd-route">{s.route}</span> : null}<span className="atlas-cmd-n">{els.length}</span></div>
                    {els.map((e) => (
                      <div key={e.nodeId} className="atlas-cmd-row">
                        <span className="atlas-cmd-act" style={{ color: atlasElementColor(e.action) }}>{e.action}</span>
                        <span className="atlas-cmd-id" title={e.label || e.testID}>{e.testID}</span>
                        <button className="atlas-cmd-run" title="Drive this command in the Browser panel" onClick={() => onDriveElement?.({ testID: e.testID, action: e.action, route: s.route ?? null })}><Icon name="play" size={10} /></button>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {showStories && effMode === "screens" ? (
          <div className="atlas-stories">
            <div className="atlas-commands-head">
              <strong>UI Stories</strong>
              <span className="atlas-commands-sub">{stories?.length ?? 0} journeys</span>
              <span className="atlas-commands-actions">
                <button className="chip" disabled={busyStories || !uiModel || uiModel.elementCount === 0} onClick={() => { setBusyStories(true); onSuggestStories?.(); }} title="Ask the model to propose user journeys from the screen map">{busyStories ? "Suggesting…" : "Suggest"}</button>
                <button className="atlas-detail-x" onClick={() => setShowStories(false)} aria-label="Close stories" title="Close"><Icon name="close" size={11} /></button>
              </span>
            </div>
            <div className="atlas-commands-body">
              {stories && stories.length ? stories.map((s) => (
                <div key={s.id} className={`atlas-story${selectedStory === s.id ? " sel" : ""}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "copy";
                    e.dataTransfer.setData("application/x-brainrouter-tag", JSON.stringify({ name: s.title, kind: "journey", ref: s.id, steps: s.steps }));
                    e.dataTransfer.setData("text/plain", `UI journey "${s.title}" (${s.steps.length} steps)`);
                  }}
                  onClick={() => setSelectedStory((cur) => (cur === s.id ? null : s.id))}
                  title="Click to trace on the map · ▶ to run · drag into chat to explain">
                  <div className="atlas-story-head">
                    <span className="atlas-story-title">{s.title}</span>
                    <button className="atlas-cmd-run" title="Run — host the app + replay this journey in the Browser panel" onClick={(e) => { e.stopPropagation(); onRunStory?.(s); }}><Icon name="play" size={10} /></button>
                  </div>
                  {s.description ? <div className="atlas-story-desc">{s.description}</div> : null}
                  <div className="atlas-story-meta">{s.steps.length} steps</div>
                </div>
              )) : <div className="atlas-story-empty">No stories yet. Click <b>Suggest</b> to have the model propose user journeys from your screen map, then Run one to watch it.</div>}
            </div>
          </div>
        ) : null}

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
