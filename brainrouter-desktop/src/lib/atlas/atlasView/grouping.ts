/**
 * Grouped structural view (ATLAS-10) — files clustered into containers, the way
 * the eye actually parses a codebase: by architectural layer when the graph is
 * enriched, else by directory. Grouping + capping + a deterministic grid pack.
 */
import type { AtlasGraph } from "@kinqs/brainrouter-types";
import { GROUPABLE, dirOf } from "./shared.js";

export interface AtlasGroup {
  id: string;
  label: string;
  nodeIds: string[];
}

/**
 * Group file-level nodes — by enrichment layer when present, else by parent
 * directory. `scope`, if given, restricts to those node ids (drill-in).
 */
export function atlasGrouping(graph: AtlasGraph, scope?: ReadonlySet<string>): AtlasGroup[] {
  const files = graph.nodes.filter((n) => GROUPABLE.has(n.type) && (!scope || scope.has(n.id)));
  if (graph.layers.length) {
    const fileIds = new Set(files.map((n) => n.id));
    const groups: AtlasGroup[] = [];
    const claimed = new Set<string>();
    for (const layer of graph.layers) {
      const ids = layer.nodeIds.filter((id) => fileIds.has(id) && !claimed.has(id));
      ids.forEach((id) => claimed.add(id));
      if (ids.length) groups.push({ id: layer.id, label: layer.name, nodeIds: ids });
    }
    const orphans = files.filter((n) => !claimed.has(n.id)).map((n) => n.id);
    if (orphans.length) groups.push({ id: "group:other", label: "Other", nodeIds: orphans });
    return groups;
  }
  const byDir = new Map<string, string[]>();
  for (const n of files) {
    const dir = dirOf(n.filePath ?? n.name);
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push(n.id);
  }
  return [...byDir.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([dir, ids]) => ({ id: `group:${dir || "root"}`, label: dir || "(root)", nodeIds: ids }));
}

/**
 * Bound the number of file nodes a grouped view renders. Large repos otherwise
 * pack thousands of nodes into a canvas far taller than wide, which fitView
 * shrinks to an unreadable strip. Keeps the BIGGEST groups first (most
 * significant), truncates the group that crosses the budget, and reports how
 * many files/groups were dropped so the UI can show a "+N more" note. A
 * non-finite cap (drill-in) returns everything untouched.
 */
export function capAtlasGroups(
  groups: AtlasGroup[],
  cap: number,
): { groups: AtlasGroup[]; hidden: number; hiddenGroups: number; shown: number } {
  const total = groups.reduce((s, g) => s + g.nodeIds.length, 0);
  if (!Number.isFinite(cap) || total <= cap) {
    return { groups, hidden: 0, hiddenGroups: 0, shown: total };
  }
  const sorted = [...groups].sort((a, b) => b.nodeIds.length - a.nodeIds.length);
  const out: AtlasGroup[] = [];
  let budget = Math.max(0, Math.floor(cap));
  let hidden = 0;
  let hiddenGroups = 0;
  for (const g of sorted) {
    if (budget <= 0) { hidden += g.nodeIds.length; hiddenGroups += 1; continue; }
    if (g.nodeIds.length <= budget) { out.push(g); budget -= g.nodeIds.length; }
    else {
      out.push({ ...g, nodeIds: g.nodeIds.slice(0, budget) });
      hidden += g.nodeIds.length - budget;
      budget = 0;
    }
  }
  return { groups: out, hidden, hiddenGroups, shown: total - hidden };
}

export interface AtlasGroupBox {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
}

export interface AtlasGroupedLayout {
  groups: AtlasGroupBox[];
  /** node id → position RELATIVE to its parent group (React Flow child coords). */
  positions: Map<string, { x: number; y: number }>;
  /** node id → group id. */
  groupOf: Map<string, string>;
}

export interface GroupedLayoutOpts {
  nodeW?: number;
  nodeH?: number;
  gap?: number;
  pad?: number;
  titleH?: number;
  groupGap?: number;
  maxRowWidth?: number;
  maxCols?: number;
  containerWidth?: number;
  containerHeight?: number;
}

/**
 * Tidy, deterministic grid-pack: each group lays its nodes in a grid; group
 * boxes flow left-to-right and wrap. No physics — clusters read as clean cards.
 */
export function atlasGroupedLayout(groups: AtlasGroup[], opts: GroupedLayoutOpts = {}): AtlasGroupedLayout {
  const nodeW = opts.nodeW ?? 152;
  const nodeH = opts.nodeH ?? 34;
  const gap = opts.gap ?? 14;
  const pad = opts.pad ?? 16;
  const titleH = opts.titleH ?? 34;
  const groupGap = opts.groupGap ?? 40;
  const explicitRowWidth = opts.maxRowWidth;

  const containerW = opts.containerWidth;
  const containerH = opts.containerHeight;

  let maxCols = opts.maxCols ?? 6;
  if (containerW) {
    const maxPossibleCols = Math.max(1, Math.floor((containerW - 64 - (pad * 2 - gap)) / (nodeW + gap)));
    maxCols = Math.min(maxCols, maxPossibleCols);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const groupOf = new Map<string, string>();

  const sized = groups.map((g) => {
    const n = Math.max(1, g.nodeIds.length);
    const cols = Math.max(1, Math.min(maxCols, Math.ceil(Math.sqrt(n))));
    const rows = Math.ceil(n / cols);
    const width = cols * nodeW + (cols - 1) * gap + pad * 2;
    const height = titleH + rows * nodeH + (rows - 1) * gap + pad * 2;
    g.nodeIds.forEach((id, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      positions.set(id, { x: pad + c * (nodeW + gap), y: titleH + pad + r * (nodeH + gap) });
      groupOf.set(id, g.id);
    });
    return { g, width, height };
  });

  // Wrap width: an explicit value wins; otherwise aim for a roughly-square
  // overall layout so large/unenriched graphs don't stack into a tall column
  // (but never narrower than the widest single group).
  const totalArea = sized.reduce((s, x) => s + x.width * x.height, 0);
  const widest = sized.reduce((m, x) => Math.max(m, x.width), 0);

  // Size the wrap width to the viewport ASPECT, not its pixel width. The canvas
  // uses fitView (it scales the whole layout to fit), so a big graph reads as a
  // wide band only when the layout's own aspect matches the viewport's — capping
  // the width to the container (the old behavior) just forced a tall strip that
  // fitView then shrank to an unreadable sliver. `widest` stays the floor.
  let maxRowWidth = explicitRowWidth;
  if (!maxRowWidth) {
    const aspect = containerW && containerH ? Math.max(1.0, Math.min(2.4, containerW / containerH)) : 1.7;
    maxRowWidth = Math.max(widest, Math.ceil(Math.sqrt(totalArea) * aspect));
  }

  const boxes: AtlasGroupBox[] = [];
  let cx = 0;
  let cy = 0;
  let rowH = 0;
  for (const { g, width, height } of sized) {
    if (cx > 0 && cx + width > maxRowWidth) {
      cx = 0;
      cy += rowH + groupGap;
      rowH = 0;
    }
    boxes.push({ id: g.id, label: g.label, x: cx, y: cy, width, height, count: g.nodeIds.length });
    cx += width + groupGap;
    rowH = Math.max(rowH, height);
  }
  return { groups: boxes, positions, groupOf };
}
