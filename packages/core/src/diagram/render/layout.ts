/**
 * Deterministic layout for the five diagram kinds (ADR-056 D-A2).
 *
 * Input is a VALIDATED document; output is a `Scene` — placed boxes, routed
 * edges, groups, bands, and a legend — in diagram units (px at 1:1). Nothing
 * here is random or time-dependent: columns come from longest-path layering
 * over the relationship direction (authored `column`/`row` hints win), order
 * within a column is authored order, and every route is a fixed orthogonal
 * shape whose vertical segments live in the gaps BETWEEN columns and whose
 * long horizontal hops travel a corridor BELOW the rows — so a route never
 * needs to cross a box to reach its target. The column gap widens to fit the
 * longest relationship label, and labels are placed by trying a fixed list of
 * candidate positions (segment midpoints, then the inter-row gaps along a
 * vertical segment) and taking the first that touches neither a box nor an
 * already-placed label. The same document therefore lays out byte-identically
 * on every run, which is what lets the receipt (checks.ts) mean something.
 *
 * The artifact checks remain the arbiter: what this placer cannot resolve is
 * reported, never silently drawn.
 */
import type {
  ArchitectureDiagram,
  DataflowDiagram,
  Diagram,
  DiagramComponentType,
  DiagramEvidence,
  DiagramRelation,
  DiagramSource,
  LifecycleDiagram,
  SequenceDiagram,
  WorkflowDiagram,
} from '@kinqs/brainrouter-types';

export type NodeShape = 'box' | 'pill' | 'diamond' | 'tool' | 'lifeline';
export type EdgeArrow = 'end' | 'both' | 'open' | 'none';
export type EdgeStroke = 'solid' | 'dashed' | 'data';

export interface PlacedNode {
  id: string;
  label: string;
  /** Semantic colour class: a component type, or a structural role for kinds without one. */
  type: DiagramComponentType | 'step' | 'state' | 'initial' | 'terminal' | 'failure' | 'waiting';
  shape: NodeShape;
  x: number; y: number; w: number; h: number;
  variant?: string;
  description?: string;
  evidence?: DiagramEvidence;
  sources?: DiagramSource[];
  /** True when the node is on the authored main path. */
  primary?: boolean;
}

export interface PlacedEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  points: Array<[number, number]>;
  stroke: EdgeStroke;
  arrow: EdgeArrow;
  labelAt?: [number, number];
  primary?: boolean;
}

export interface PlacedGroup { id: string; label: string; x: number; y: number; w: number; h: number; kind: string }
export interface Band { id: string; label: string; x: number; y: number; w: number; h: number; axis: 'row' | 'column' }
export interface LegendEntry { key: string; label: string }

export interface Scene {
  kind: Diagram['kind'];
  width: number;
  height: number;
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  groups: PlacedGroup[];
  bands: Band[];
  legend: LegendEntry[];
  /** Sequence-only: activation bars. */
  activations?: Array<{ participant: string; x: number; y: number; h: number }>;
}

// ---- metrics ----------------------------------------------------------------

export const METRICS = {
  padding: 48,
  nodeH: 56,
  nodeMinW: 128,
  nodeMaxW: 240,
  charW: 7.4,
  colGapMin: 120,
  rowGap: 48,
  groupPad: 28,
  groupTitle: 26,
  bandTitle: 28,
  corridorGap: 22,
  corridorStep: 14,
  seqColGap: 200,
  seqBoxW: 150,
  seqBoxH: 44,
  seqMsgGap: 52,
  labelH: 18,
  fontPx: 13,
} as const;

/** Text width estimate for a 13px UI face — the only text metric the layout relies on. */
export function textWidth(text: string): number {
  return Math.ceil(text.length * METRICS.charW);
}

function nodeWidth(label: string): number {
  return Math.min(METRICS.nodeMaxW, Math.max(METRICS.nodeMinW, textWidth(label) + 36));
}

const labelBox = (label: string, at: [number, number]): Rect => {
  const w = textWidth(label) + 12;
  return { x: at[0] - w / 2, y: at[1] - METRICS.labelH / 2, w, h: METRICS.labelH };
};

// ---- layering ---------------------------------------------------------------

/**
 * Longest-path layering: a node's column is one past the deepest column among
 * its predecessors; cycles are broken by authored order (an edge that points
 * to an earlier-declared node never advances a column). Hints override.
 */
function layerColumns(ids: string[], rels: readonly DiagramRelation[], hints: Map<string, number>): Map<string, number> {
  const order = new Map(ids.map((id, i) => [id, i]));
  const col = new Map<string, number>();
  const forward = rels.filter((r) => (order.get(r.from) ?? 0) < (order.get(r.to) ?? 0));
  const preds = new Map<string, string[]>();
  for (const r of forward) preds.set(r.to, [...(preds.get(r.to) ?? []), r.from]);
  const visit = (id: string, stack: Set<string>): number => {
    if (hints.has(id)) return hints.get(id)!;
    if (col.has(id)) return col.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    const p = preds.get(id) ?? [];
    const c = p.length ? Math.max(...p.map((q) => visit(q, stack))) + 1 : 0;
    stack.delete(id);
    col.set(id, c);
    return c;
  };
  for (const id of ids) col.set(id, visit(id, new Set()));
  return col;
}

interface Slot { id: string; col: number; row: number }

/**
 * Rows within a column follow authored order. A `row` hint is a preference:
 * when two hinted nodes share a column and a row, the later one takes the next
 * free row at or below its hint, so a hint can never produce an overlap.
 */
function assignRows(ids: string[], cols: Map<string, number>, rowHints: Map<string, number>): Slot[] {
  const byCol = new Map<number, string[]>();
  for (const id of ids) byCol.set(cols.get(id)!, [...(byCol.get(cols.get(id)!) ?? []), id]);
  const slots: Slot[] = [];
  for (const [c, members] of [...byCol.entries()].sort((a, b) => a[0] - b[0])) {
    const taken = new Set<number>();
    const place = (from: number): number => { let r = from; while (taken.has(r)) r++; taken.add(r); return r; };
    const hinted = members.filter((id) => rowHints.has(id));
    const free = members.filter((id) => !rowHints.has(id));
    const rowOf = new Map<string, number>();
    for (const id of hinted) rowOf.set(id, place(rowHints.get(id)!));
    for (const id of free) rowOf.set(id, place(0));
    for (const id of members) slots.push({ id, col: c, row: rowOf.get(id)! });
  }
  return slots;
}

// ---- grid -------------------------------------------------------------------

type Rect = { x: number; y: number; w: number; h: number };

interface Grid {
  rects: Map<string, Rect>;
  cols: Map<string, number>;
  rows: Map<string, number>;
  rowsUsed: number;
  colsUsed: number;
  colX: number[];
  colW: number[];
  colGap: number;
  originY: number;
  /** y just below the last row. */
  bottom: number;
}

interface GridInput {
  ids: string[];
  labels: Map<string, string>;
  rels: readonly DiagramRelation[];
  colHints: Map<string, number>;
  rowHints: Map<string, number>;
  originX: number;
  originY: number;
}

function placeGrid(input: GridInput): Grid {
  const cols = layerColumns(input.ids, input.rels, input.colHints);
  const slots = assignRows(input.ids, cols, input.rowHints);
  const colsUsed = Math.max(...slots.map((s) => s.col)) + 1;
  const rowsUsed = Math.max(...slots.map((s) => s.row)) + 1;
  const longestLabel = Math.max(0, ...input.rels.map((r) => (r.label ? textWidth(r.label) + 12 : 0)));
  const colGap = Math.max(METRICS.colGapMin, longestLabel + 32);
  const colW: number[] = [];
  for (let c = 0; c < colsUsed; c++) {
    colW.push(Math.max(METRICS.nodeMinW, ...slots.filter((s) => s.col === c).map((s) => nodeWidth(input.labels.get(s.id) ?? s.id))));
  }
  const colX: number[] = [];
  let x = input.originX;
  for (let c = 0; c < colsUsed; c++) { colX.push(x); x += colW[c] + colGap; }
  const rects = new Map<string, Rect>();
  const rows = new Map<string, number>();
  for (const s of slots) {
    const w = nodeWidth(input.labels.get(s.id) ?? s.id);
    rects.set(s.id, { x: colX[s.col] + (colW[s.col] - w) / 2, y: input.originY + s.row * (METRICS.nodeH + METRICS.rowGap), w, h: METRICS.nodeH });
    rows.set(s.id, s.row);
  }
  const bottom = input.originY + rowsUsed * (METRICS.nodeH + METRICS.rowGap) - METRICS.rowGap;
  return { rects, cols, rows, rowsUsed, colsUsed, colX, colW, colGap, originY: input.originY, bottom };
}

// ---- routing ----------------------------------------------------------------

const cy = (r: Rect): number => r.y + r.h / 2;
const cx = (r: Rect): number => r.x + r.w / 2;

/**
 * Orthogonal route between two boxes on the grid. Vertical travel happens in
 * the gap beside a column (never inside one); any hop across more than one
 * column, and every backward hop, uses a corridor below the rows. `lane`
 * staggers parallel corridor runs so they do not overprint each other.
 */
function routeOnGrid(g: Grid, a: Rect, b: Rect, ca: number, cb: number, ra: number, rb: number, lane: number): Array<[number, number]> {
  const half = g.colGap / 2;
  const corridorY = g.bottom + METRICS.corridorGap + lane * METRICS.corridorStep;
  if (ca === cb) {
    if (Math.abs(ra - rb) === 1) {
      const x = cx(a);
      return rb > ra ? [[x, a.y + a.h], [x, b.y]] : [[x, a.y], [x, b.y + b.h]];
    }
    const gx = g.colX[ca] + g.colW[ca] + half;
    return [[a.x + a.w, cy(a)], [gx, cy(a)], [gx, cy(b)], [b.x + b.w, cy(b)]];
  }
  if (cb === ca + 1) {
    if (Math.abs(cy(a) - cy(b)) < 1) return [[a.x + a.w, cy(a)], [b.x, cy(b)]];
    const gx = g.colX[ca] + g.colW[ca] + half;
    return [[a.x + a.w, cy(a)], [gx, cy(a)], [gx, cy(b)], [b.x, cy(b)]];
  }
  if (cb > ca) {
    const g1 = g.colX[ca] + g.colW[ca] + half;
    const g2 = g.colX[cb] - half;
    return [[a.x + a.w, cy(a)], [g1, cy(a)], [g1, corridorY], [g2, corridorY], [g2, cy(b)], [b.x, cy(b)]];
  }
  // Backward: leave left, drop to the corridor, travel left, rise beside the target, enter from its right.
  const g1 = g.colX[ca] - half;
  const g2 = g.colX[cb] + g.colW[cb] + half;
  return [[a.x, cy(a)], [g1, cy(a)], [g1, corridorY], [g2, corridorY], [g2, cy(b)], [b.x + b.w, cy(b)]];
}

function selfLoop(a: Rect): Array<[number, number]> {
  const x = a.x + a.w - 22;
  return [[x, a.y + a.h], [x, a.y + a.h + 20], [a.x + a.w + 18, a.y + a.h + 20], [a.x + a.w + 18, cy(a)], [a.x + a.w, cy(a)]];
}

// ---- labels -----------------------------------------------------------------

const overlaps = (p: Rect, q: Rect): boolean => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;

/** Candidate label anchors for a route: each segment's midpoint, then each inter-row gap a vertical segment passes through. */
function labelCandidates(points: Array<[number, number]>, g: Grid | null): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const segs: Array<{ i: number; len: number }> = [];
  for (let i = 0; i + 1 < points.length; i++) {
    segs.push({ i, len: Math.abs(points[i + 1][0] - points[i][0]) + Math.abs(points[i + 1][1] - points[i][1]) });
  }
  // Longest segment first, then authored order.
  segs.sort((p, q) => q.len - p.len || p.i - q.i);
  for (const { i } of segs) {
    const [x1, y1] = points[i], [x2, y2] = points[i + 1];
    out.push([(x1 + x2) / 2, (y1 + y2) / 2]);
  }
  if (g) {
    for (const { i } of segs) {
      const [x1, y1] = points[i], [x2, y2] = points[i + 1];
      if (Math.abs(x1 - x2) > 0.5) continue;
      const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
      for (let r = 0; r + 1 < g.rowsUsed; r++) {
        const gapY = g.originY + r * (METRICS.nodeH + METRICS.rowGap) + METRICS.nodeH + METRICS.rowGap / 2;
        if (gapY > lo && gapY < hi) out.push([x1, gapY]);
      }
    }
  }
  return out;
}

/** Choose the first candidate that touches neither a box nor a placed label; fall back to the first candidate. */
function placeLabel(label: string, points: Array<[number, number]>, g: Grid | null, blockers: Rect[]): [number, number] {
  const candidates = labelCandidates(points, g);
  for (const c of candidates) {
    const box = labelBox(label, c);
    if (!blockers.some((b) => overlaps(box, b))) { blockers.push(box); return c; }
  }
  const first = candidates[0] ?? points[0];
  blockers.push(labelBox(label, first));
  return first;
}

// ---- edges over a grid ------------------------------------------------------

function gridEdges(g: Grid, rels: readonly DiagramRelation[], strokeOf: (r: DiagramRelation) => EdgeStroke, arrowOf: (r: DiagramRelation) => EdgeArrow, primary: Set<string>): PlacedEdge[] {
  const blockers: Rect[] = [...g.rects.values()].map((r) => ({ ...r }));
  let corridorLane = 0;
  const edges: PlacedEdge[] = [];
  for (const r of rels) {
    const a = g.rects.get(r.from)!, b = g.rects.get(r.to)!;
    const ca = g.cols.get(r.from)!, cb = g.cols.get(r.to)!;
    const usesCorridor = r.from !== r.to && (cb < ca || cb > ca + 1);
    const points = r.from === r.to ? selfLoop(a) : routeOnGrid(g, a, b, ca, cb, g.rows.get(r.from)!, g.rows.get(r.to)!, usesCorridor ? corridorLane++ : 0);
    const edge: PlacedEdge = { id: r.id, from: r.from, to: r.to, points, stroke: strokeOf(r), arrow: arrowOf(r) };
    if (r.label) { edge.label = r.label; edge.labelAt = placeLabel(r.label, points, g, blockers); }
    if (primary.has(`${r.from}>${r.to}`) || primary.has(`${r.to}>${r.from}`)) edge.primary = true;
    edges.push(edge);
  }
  return edges;
}

function primaryPairs(mainPath: string[] | undefined): Set<string> {
  const out = new Set<string>();
  if (!mainPath) return out;
  for (let i = 0; i + 1 < mainPath.length; i++) out.add(`${mainPath[i]}>${mainPath[i + 1]}`);
  return out;
}

function frame(nodes: PlacedNode[], groups: PlacedGroup[], bands: Band[], edges: PlacedEdge[]): { width: number; height: number } {
  let maxX = 0, maxY = 0;
  for (const n of nodes) { maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h); }
  for (const g of groups) { maxX = Math.max(maxX, g.x + g.w); maxY = Math.max(maxY, g.y + g.h); }
  for (const b of bands) { maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h); }
  for (const e of edges) {
    for (const [x, y] of e.points) { maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    if (e.label && e.labelAt) { const lb = labelBox(e.label, e.labelAt); maxX = Math.max(maxX, lb.x + lb.w); maxY = Math.max(maxY, lb.y + lb.h); }
  }
  return { width: Math.ceil(maxX + METRICS.padding), height: Math.ceil(maxY + METRICS.padding) };
}

const TYPE_LABELS: Record<string, string> = {
  frontend: 'Frontend', backend: 'Backend', database: 'Database', cloud: 'Cloud', security: 'Security', messagebus: 'Message bus', external: 'External',
  step: 'Step', state: 'State', initial: 'Initial', terminal: 'Terminal', failure: 'Failure', waiting: 'Waiting',
};

function legendFor(nodes: PlacedNode[]): LegendEntry[] {
  const keys = [...new Set(nodes.map((n) => n.type))];
  return keys.map((k) => ({ key: k, label: TYPE_LABELS[k] ?? k }));
}

function baseNode<T extends { id: string; label: string; description?: string; evidence?: DiagramEvidence; sources?: DiagramSource[] }>(el: T, type: PlacedNode['type'], shape: NodeShape, r: Rect): PlacedNode {
  const n: PlacedNode = { id: el.id, label: el.label, type, shape, ...r };
  if (el.description) n.description = el.description;
  if (el.evidence) n.evidence = el.evidence;
  if (el.sources) n.sources = el.sources;
  return n;
}

// ---- architecture -----------------------------------------------------------

function layoutArchitecture(doc: ArchitectureDiagram): Scene {
  const ids = doc.components.map((c) => c.id);
  const labels = new Map(doc.components.map((c) => [c.id, c.label]));
  const colHints = new Map<string, number>(), rowHints = new Map<string, number>();
  for (const c of doc.components) { if (c.column !== undefined) colHints.set(c.id, c.column); if (c.row !== undefined) rowHints.set(c.id, c.row); }
  const origin = METRICS.padding + (doc.boundaries?.length ? METRICS.groupPad + METRICS.groupTitle : 0);
  const grid = placeGrid({ ids, labels, rels: doc.connections, colHints, rowHints, originX: origin, originY: origin });
  const onPath = new Set(doc.mainPath ?? []);
  const nodes = doc.components.map((c) => {
    const n = baseNode(c, c.type, 'box', grid.rects.get(c.id)!);
    if (c.variant) n.variant = c.variant;
    if (onPath.has(c.id)) n.primary = true;
    return n;
  });
  const groups: PlacedGroup[] = (doc.boundaries ?? []).map((b) => {
    const rs = b.wraps.map((id) => grid.rects.get(id)!);
    const x = Math.min(...rs.map((r) => r.x)) - METRICS.groupPad;
    const y = Math.min(...rs.map((r) => r.y)) - METRICS.groupPad - METRICS.groupTitle;
    const x2 = Math.max(...rs.map((r) => r.x + r.w)) + METRICS.groupPad;
    const y2 = Math.max(...rs.map((r) => r.y + r.h)) + METRICS.groupPad;
    return { id: b.id, label: b.label, x, y, w: x2 - x, h: y2 - y, kind: b.kind ?? 'group' };
  });
  type Conn = ArchitectureDiagram['connections'][number];
  const edges = gridEdges(grid, doc.connections,
    (r) => ((r as Conn).style === 'async' ? 'dashed' : (r as Conn).style === 'data' ? 'data' : 'solid'),
    (r) => ((r as Conn).direction === 'both' ? 'both' : 'end'),
    primaryPairs(doc.mainPath));
  const size = frame(nodes, groups, [], edges);
  return { kind: 'architecture', ...size, nodes, edges, groups, bands: [], legend: legendFor(nodes) };
}

// ---- workflow ---------------------------------------------------------------

function layoutWorkflow(doc: WorkflowDiagram): Scene {
  const lanes = doc.lanes ?? [];
  const laneIndex = new Map(lanes.map((l, i) => [l.id, i]));
  const ids = doc.nodes.map((n) => n.id);
  const labels = new Map(doc.nodes.map((n) => [n.id, n.label]));
  const rowHints = new Map<string, number>();
  for (const n of doc.nodes) if (n.lane && laneIndex.has(n.lane)) rowHints.set(n.id, laneIndex.get(n.lane)!);
  const originX = METRICS.padding + (lanes.length ? 120 : 0);
  const originY = METRICS.padding + (lanes.length ? METRICS.bandTitle : 0);
  const grid = placeGrid({ ids, labels, rels: doc.edges, colHints: new Map(), rowHints, originX, originY });
  const onPath = new Set(doc.mainPath ?? []);
  const nodes = doc.nodes.map((n) => {
    const shape: NodeShape = n.shape === 'decision' ? 'diamond' : n.shape === 'start' || n.shape === 'end' ? 'pill' : n.shape === 'tool' ? 'tool' : 'box';
    const out = baseNode(n, 'step', shape, grid.rects.get(n.id)!);
    if (onPath.has(n.id)) out.primary = true;
    return out;
  });
  const edges = gridEdges(grid, doc.edges, () => 'solid', () => 'end', primaryPairs(doc.mainPath));
  const rowH = METRICS.nodeH + METRICS.rowGap;
  const width = Math.max(...nodes.map((n) => n.x + n.w), ...edges.flatMap((e) => e.points.map((p) => p[0]))) + METRICS.padding;
  const bands: Band[] = lanes.map((l, i) => ({ id: l.id, label: l.label, x: METRICS.padding, y: originY + i * rowH - METRICS.rowGap / 2, w: width - METRICS.padding * 2, h: rowH, axis: 'row' }));
  const size = frame(nodes, [], bands, edges);
  return { kind: 'workflow', ...size, nodes, edges, groups: [], bands, legend: [] };
}

// ---- sequence ---------------------------------------------------------------

function layoutSequence(doc: SequenceDiagram): Scene {
  const top = METRICS.padding;
  const xOf = new Map<string, number>();
  doc.participants.forEach((p, i) => xOf.set(p.id, METRICS.padding + i * METRICS.seqColGap + METRICS.seqBoxW / 2));
  const msgTop = top + METRICS.seqBoxH + 36;
  const height = msgTop + doc.messages.length * METRICS.seqMsgGap + METRICS.padding;
  const nodes: PlacedNode[] = doc.participants.map((p) => {
    const c = xOf.get(p.id)!;
    return baseNode(p, p.type ?? 'backend', 'lifeline', { x: c - METRICS.seqBoxW / 2, y: top, w: METRICS.seqBoxW, h: height - top - METRICS.padding });
  });
  const yOf = new Map<string, number>();
  const blockers: Rect[] = nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: METRICS.seqBoxH }));
  const edges: PlacedEdge[] = doc.messages.map((m, i) => {
    const y = msgTop + i * METRICS.seqMsgGap;
    yOf.set(m.id, y);
    const x1 = xOf.get(m.from)!, x2 = xOf.get(m.to)!;
    const points: Array<[number, number]> = m.from === m.to
      ? [[x1, y], [x1 + 60, y], [x1 + 60, y + 24], [x1, y + 24]]
      : [[x1, y], [x2, y]];
    const mid = m.from === m.to ? x1 + 30 : (x1 + x2) / 2;
    const at: [number, number] = [mid, y - 11];
    blockers.push(labelBox(m.label, at));
    return { id: m.id, from: m.from, to: m.to, points, stroke: m.kind === 'return' ? 'dashed' : 'solid', arrow: m.kind === 'async' ? 'open' : 'end', label: m.label, labelAt: at };
  });
  const activations = (doc.activations ?? []).map((a) => {
    const y1 = yOf.get(a.fromMessage)!, y2 = yOf.get(a.toMessage)!;
    return { participant: a.participant, x: xOf.get(a.participant)! - 6, y: y1, h: y2 - y1 + 12 };
  });
  const width = METRICS.padding + (doc.participants.length - 1) * METRICS.seqColGap + METRICS.seqBoxW + METRICS.padding;
  return { kind: 'sequence', width, height, nodes, edges, groups: [], bands: [], legend: legendFor(nodes), activations };
}

// ---- dataflow ---------------------------------------------------------------

function layoutDataflow(doc: DataflowDiagram): Scene {
  const stages = doc.stages ?? [];
  const stageIndex = new Map(stages.map((s, i) => [s.id, i]));
  const ids = doc.nodes.map((n) => n.id);
  const labels = new Map(doc.nodes.map((n) => [n.id, n.label]));
  const colHints = new Map<string, number>();
  for (const n of doc.nodes) if (n.stage && stageIndex.has(n.stage)) colHints.set(n.id, stageIndex.get(n.stage)!);
  const originY = METRICS.padding + (stages.length ? METRICS.bandTitle + 12 : 0);
  const grid = placeGrid({ ids, labels, rels: doc.flows, colHints, rowHints: new Map(), originX: METRICS.padding + 16, originY });
  const nodes = doc.nodes.map((n) => baseNode(n, n.type ?? 'backend', 'box', grid.rects.get(n.id)!));
  const edges = gridEdges(grid, doc.flows, () => 'data', () => 'end', new Set());
  const bandBottom = Math.max(grid.bottom, ...edges.flatMap((e) => e.points.map((p) => p[1]))) + 16;
  const bands: Band[] = stages.map((s, i) => {
    const c = Math.min(i, grid.colsUsed - 1);
    return { id: s.id, label: s.label, x: grid.colX[c] - 16, y: METRICS.padding, w: grid.colW[c] + 32, h: bandBottom - METRICS.padding, axis: 'column' };
  });
  const size = frame(nodes, [], bands, edges);
  return { kind: 'dataflow', ...size, nodes, edges, groups: [], bands, legend: legendFor(nodes) };
}

// ---- lifecycle --------------------------------------------------------------

function layoutLifecycle(doc: LifecycleDiagram): Scene {
  const ids = doc.states.map((s) => s.id);
  const labels = new Map(doc.states.map((s) => [s.id, s.label]));
  // Terminal and failure states prefer the row below the main rail so retries read as loops.
  const rowHints = new Map<string, number>();
  for (const s of doc.states) if (s.type === 'terminal' || s.type === 'failure') rowHints.set(s.id, 1);
  const grid = placeGrid({ ids, labels, rels: doc.transitions, colHints: new Map(), rowHints, originX: METRICS.padding, originY: METRICS.padding });
  const nodes = doc.states.map((s) => {
    const type = s.type === 'initial' ? 'initial' : s.type === 'terminal' ? 'terminal' : s.type === 'failure' ? 'failure' : s.type === 'waiting' ? 'waiting' : 'state';
    return baseNode(s, type, 'pill', grid.rects.get(s.id)!);
  });
  const edges = gridEdges(grid, doc.transitions, () => 'solid', () => 'end', new Set());
  const size = frame(nodes, [], [], edges);
  return { kind: 'lifecycle', ...size, nodes, edges, groups: [], bands: [], legend: legendFor(nodes) };
}

/** Lay out a validated document. */
export function layoutDiagram(doc: Diagram): Scene {
  switch (doc.kind) {
    case 'architecture': return layoutArchitecture(doc);
    case 'workflow': return layoutWorkflow(doc);
    case 'sequence': return layoutSequence(doc);
    case 'dataflow': return layoutDataflow(doc);
    case 'lifecycle': return layoutLifecycle(doc);
  }
}
