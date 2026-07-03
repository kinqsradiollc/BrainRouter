/**
 * VISUAL WORKFLOW CANVAS — graph DSL + pure graph utilities (§7 L2).
 *
 * The desktop canvas (React Flow) serializes to a {@link WorkflowGraph}; this
 * module is the format-agnostic, dependency-free core: validation, cycle
 * detection, topological ordering, `{{$nodes.*}}` / `{{$vars.*}}` interpolation,
 * and secret-stripped export. The actual execution lives in `graphEngine.ts`
 * (which uses the existing orchestrator for agent nodes). All pure → unit-tested.
 *
 * This is a NODE-graph dataflow model, distinct from (and complementary to) the
 * phase-plan workflow engine: phase plans fan out + synthesize; the canvas wires
 * arbitrary nodes with conditional routing and `$nodes` data passing.
 */

export type WorkflowNodeType =
  | 'trigger' | 'agent' | 'set' | 'condition' | 'merge' | 'output'
  // §7 L3 — advanced nodes
  | 'switch'      // multi-branch on a value matched against declared cases
  | 'filter'      // keep array items matching field/op/value
  | 'sort'        // order an array by a field
  | 'limit'       // take the first N array items
  | 'aggregate'   // reduce an array → scalar (count/sum/avg/min/max/join/first/last)
  | 'loop'        // iterate an agent body: 'foreach' an array, or 'refine' until a stop string
  | 'approval'    // human-approval pause (branches approved/rejected via the injected approver)
  | 'extract'     // LLM parameter-extractor → JSON object
  | 'classify'    // LLM question-classifier → branch = chosen label
  | 'subworkflow';// run a saved graph as a node (depth + recursion guarded)

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  /** Per-type config (agent prompt, set fields, condition left/op/right, output template). */
  data?: Record<string, unknown>;
  /** UI position — ignored by the engine. */
  position?: { x: number; y: number };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** Branch label for a condition node's outgoing edge: 'true' | 'false'. Undefined = unconditional. */
  sourceHandle?: string;
}

export interface WorkflowGraph {
  id?: string;
  name?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Initial run variables, available as `{{$vars.*}}`. */
  vars?: Record<string, unknown>;
}

export interface GraphValidation {
  ok: boolean;
  errors: string[];
}

/** Structural validation: unique ids, edge endpoints exist, ≥1 trigger, acyclic. */
export function validateGraph(graph: WorkflowGraph): GraphValidation {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (!n.id) errors.push('a node is missing an id');
    else if (ids.has(n.id)) errors.push(`duplicate node id: ${n.id}`);
    else ids.add(n.id);
  }
  for (const e of graph.edges) {
    if (!ids.has(e.source)) errors.push(`edge ${e.id} source "${e.source}" is not a node`);
    if (!ids.has(e.target)) errors.push(`edge ${e.id} target "${e.target}" is not a node`);
  }
  if (!graph.nodes.some((n) => n.type === 'trigger')) errors.push('graph has no trigger node');
  if (detectCycle(graph)) errors.push('graph contains a cycle (use a Loop node for iteration)');
  return { ok: errors.length === 0, errors };
}

function adjacency(graph: WorkflowGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const e of graph.edges) adj.get(e.source)?.push(e.target);
  return adj;
}

/** True if the graph has a directed cycle (3-colour DFS). */
export function detectCycle(graph: WorkflowGraph): boolean {
  const adj = adjacency(graph);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of graph.nodes) color.set(n.id, WHITE);
  const dfs = (u: string): boolean => {
    color.set(u, GRAY);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v);
      if (c === GRAY) return true;
      if (c === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK);
    return false;
  };
  for (const n of graph.nodes) {
    if (color.get(n.id) === WHITE && dfs(n.id)) return true;
  }
  return false;
}

/** Topological node-id order (Kahn). Throws on a cycle. */
export function topoOrder(graph: WorkflowGraph): string[] {
  const adj = adjacency(graph);
  const indeg = new Map<string, number>();
  for (const n of graph.nodes) indeg.set(n.id, 0);
  for (const e of graph.edges) if (indeg.has(e.target)) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = graph.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of adj.get(u) ?? []) {
      indeg.set(v, (indeg.get(v) ?? 0) - 1);
      if ((indeg.get(v) ?? 0) === 0) queue.push(v);
    }
  }
  if (order.length !== graph.nodes.length) throw new Error('graph contains a cycle');
  return order;
}

// ---------------------------------------------------------------------------
// interpolation: {{$nodes.<id>.<path>}} and {{$vars.<name>}}
// ---------------------------------------------------------------------------

const TOKEN = /\{\{\s*\$(nodes|vars)\.([^}]+?)\s*\}\}/g;

export interface InterpContext {
  nodes: Record<string, unknown>;
  vars: Record<string, unknown>;
}

/** Resolve `{{$nodes.id.field}}` / `{{$vars.name}}` against a run context. */
export function interpolate(template: string, ctx: InterpContext): string {
  return template.replace(TOKEN, (_m, kind: string, pathExpr: string) => {
    const root = kind === 'nodes' ? ctx.nodes : ctx.vars;
    const val = getPath(root, pathExpr.trim());
    if (val === undefined || val === null) return '';
    return typeof val === 'string' ? val : JSON.stringify(val);
  });
}

function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// ---------------------------------------------------------------------------
// secret-stripped export
// ---------------------------------------------------------------------------

const SECRET_KEY = /(api[-_]?key|token|secret|password|authorization|cookie)/i;

/**
 * A copy of the graph safe to export/share: any node-data field whose key looks
 * like a credential is replaced with `''`. Pure (does not mutate the input).
 */
export function stripSecretsForExport(graph: WorkflowGraph): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => ({
      ...n,
      data: n.data ? scrub(n.data) : n.data,
    })),
  };
}

function scrub(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SECRET_KEY.test(k)) out[k] = '';
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = scrub(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}
