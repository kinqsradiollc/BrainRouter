/**
 * VISUAL WORKFLOW CANVAS — graph execution engine (§7 L2).
 *
 * Runs a {@link WorkflowGraph} node-by-node in topological order with conditional
 * routing and `$nodes` data passing. The only side-effecting node — `agent` —
 * delegates to an INJECTED `runAgent` (the desktop/agent wires this to the
 * existing `task_agent` orchestration primitive), so the engine is fully
 * unit-testable with a mock. Pure node types (trigger/set/condition/merge/output)
 * execute inline. Cycle guard is inherited from `topoOrder` (loops are L3).
 */

import {
  validateGraph,
  topoOrder,
  interpolate,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowEdge,
  type InterpContext,
} from './graph.js';

export interface GraphRunDeps {
  /**
   * Execute one `agent` node's (interpolated) prompt and return its text output.
   * Injected so the engine never imports the orchestrator — the caller wires it
   * to `task_agent`. A throw fails the node (and, by default, the run).
   */
  runAgent: (prompt: string, node: WorkflowNode) => Promise<string>;
}

export interface NodeRunRecord {
  id: string;
  type: string;
  status: 'ok' | 'skipped' | 'error';
  output?: unknown;
  /** For a condition node: which handle ('true' | 'false') fired. */
  branch?: string;
  error?: string;
}

export interface GraphRunResult {
  ok: boolean;
  order: string[];
  nodes: Record<string, NodeRunRecord>;
  /** Text of the last `output` node that ran, if any. */
  finalOutput?: string;
  error?: string;
}

function compare(a: string, op: string, b: string): boolean {
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case 'contains': return a.includes(b);
    case '>': return Number(a) > Number(b);
    case '<': return Number(a) < Number(b);
    case 'truthy': return a !== '' && a !== 'false' && a !== '0';
    default: return false;
  }
}

/**
 * Execute a single node against a context (the building block, also exported for
 * the canvas's "test this node" affordance). `upstream` is the list of active
 * incoming nodes' outputs, used by `merge`.
 */
export async function runSingleNode(
  node: WorkflowNode,
  ctx: InterpContext,
  deps: GraphRunDeps,
  upstream: Array<{ id: string; output: unknown }> = [],
): Promise<NodeRunRecord> {
  const data = node.data ?? {};
  switch (node.type) {
    case 'trigger':
      return { id: node.id, type: 'trigger', status: 'ok', output: { ...ctx.vars } };
    case 'set': {
      const fields = data.fields && typeof data.fields === 'object' ? (data.fields as Record<string, unknown>) : {};
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        out[k] = typeof v === 'string' ? interpolate(v, ctx) : v;
        ctx.vars[k] = out[k]; // a Set node also writes run variables
      }
      return { id: node.id, type: 'set', status: 'ok', output: out };
    }
    case 'condition': {
      const left = interpolate(String(data.left ?? ''), ctx);
      const right = interpolate(String(data.right ?? ''), ctx);
      const result = compare(left, String(data.op ?? '=='), right);
      return { id: node.id, type: 'condition', status: 'ok', output: { result }, branch: result ? 'true' : 'false' };
    }
    case 'merge':
      return { id: node.id, type: 'merge', status: 'ok', output: { inputs: upstream.map((u) => u.output) } };
    case 'agent': {
      const prompt = interpolate(String(data.prompt ?? ''), ctx);
      const text = await deps.runAgent(prompt, node);
      return { id: node.id, type: 'agent', status: 'ok', output: { text } };
    }
    case 'output': {
      const text = interpolate(String(data.template ?? ''), ctx);
      return { id: node.id, type: 'output', status: 'ok', output: { text } };
    }
    default:
      throw new Error(`unknown node type: ${(node as WorkflowNode).type}`);
  }
}

/**
 * Run a whole graph. A node runs when it is a trigger OR has ≥1 active incoming
 * edge; a condition node only activates the outgoing edges whose handle matches
 * its result. The first node error fails the run (fail-closed) and is reported.
 */
export async function runGraph(graph: WorkflowGraph, deps: GraphRunDeps): Promise<GraphRunResult> {
  const validation = validateGraph(graph);
  if (!validation.ok) return { ok: false, order: [], nodes: {}, error: validation.errors.join('; ') };

  const order = topoOrder(graph);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const n of graph.nodes) incoming.set(n.id, []);
  for (const e of graph.edges) incoming.get(e.target)?.push(e);

  const records: Record<string, NodeRunRecord> = {};
  const ctx: InterpContext = { nodes: {}, vars: { ...(graph.vars ?? {}) } };
  const activeEdges = new Set<string>();
  let finalOutput: string | undefined;

  const isActive = (nodeId: string): boolean => {
    if (nodeById.get(nodeId)?.type === 'trigger') return true;
    return (incoming.get(nodeId) ?? []).some((e) => activeEdges.has(e.id));
  };

  for (const id of order) {
    const node = nodeById.get(id)!;
    if (!isActive(id)) {
      records[id] = { id, type: node.type, status: 'skipped' };
      continue;
    }
    const upstream = (incoming.get(id) ?? [])
      .filter((e) => activeEdges.has(e.id))
      .map((e) => ({ id: e.source, output: ctx.nodes[e.source] }));
    try {
      const rec = await runSingleNode(node, ctx, deps, upstream);
      records[id] = rec;
      ctx.nodes[id] = rec.output;
      if (node.type === 'output' && typeof (rec.output as { text?: unknown })?.text === 'string') {
        finalOutput = (rec.output as { text: string }).text;
      }
      for (const e of graph.edges) {
        if (e.source !== id) continue;
        if (node.type === 'condition' && e.sourceHandle && e.sourceHandle !== rec.branch) continue;
        activeEdges.add(e.id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      records[id] = { id, type: node.type, status: 'error', error: message };
      return { ok: false, order, nodes: records, finalOutput, error: `node ${id} failed: ${message}` };
    }
  }

  return { ok: true, order, nodes: records, finalOutput };
}
