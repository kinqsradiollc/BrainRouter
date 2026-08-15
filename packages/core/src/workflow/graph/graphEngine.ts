/**
 * VISUAL WORKFLOW CANVAS — graph execution engine (§7 L2 + L3).
 *
 * Runs a {@link WorkflowGraph} node-by-node in topological order with conditional
 * routing and `$nodes` data passing. The only side-effecting node — `agent` (and
 * the LLM-backed `loop`/`extract`/`classify`) — delegates to an INJECTED
 * `runAgent` (the desktop/agent wires this to the existing `task_agent`
 * orchestration primitive), so the engine is fully unit-testable with a mock.
 * Pure data nodes (trigger/set/condition/merge/output + switch/filter/sort/limit/
 * aggregate) execute inline. `subworkflow` re-enters {@link runGraph} under a
 * depth + recursion guard; `approval` consults an injected approver and halts its
 * branch on reject. Graph-level cycles are still rejected by `topoOrder`;
 * iteration lives INSIDE a `loop` node, so the graph stays acyclic.
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

/** A sub-workflow nest deeper than this fails closed (runaway guard). */
export const MAX_SUBWORKFLOW_DEPTH = 8;
/**
 * Total node executions allowed per run. Depth bounds nesting; this bounds WORK.
 * A single graph with a loop needs no nesting at all to run forever.
 */
export const DEFAULT_EXECUTION_BUDGET = 500;

export interface GraphRunDeps {
  /**
   * Execute one node's (interpolated) prompt and return its text output. Used by
   * `agent`, `loop`, `extract`, `classify`. Injected so the engine never imports
   * the orchestrator — the caller wires it to `task_agent`. A throw fails the
   * node (and, by default, the run).
   */
  runAgent: (prompt: string, node: WorkflowNode) => Promise<string>;
  /**
   * Resolve a saved graph by id/name for a `subworkflow` node. Optional: when
   * absent, a `subworkflow` node fails with a clear message. Wired by the caller
   * to the graph store.
   */
  loadSubWorkflow?: (idOrName: string) => Promise<WorkflowGraph | null>;
  /**
   * Ask a human to approve an `approval` node, returning true to continue.
   *
   * ADR-040 A40-3: when this is absent the node now FAILS, it does not pass.
   * It used to auto-pass "so headless runs don't block", which meant the one
   * node type whose entire purpose is to stop and ask a human was a no-op in
   * exactly the configuration where nobody is watching. A gate that opens when
   * its keyholder is missing is not a gate.
   *
   * A run that genuinely wants no human in the loop says so explicitly with
   * `allowUnattendedApproval`, which is recorded on the node so the decision is
   * visible in the execution map rather than inferred from an absent callback.
   */
  requestApproval?: (node: WorkflowNode, summary: string) => Promise<boolean>;
  /**
   * Explicit opt-in to running `approval` nodes with no human present. Off by
   * default: the caller must state it, and every such node is flagged
   * `unattended: true` in its record.
   */
  allowUnattendedApproval?: boolean;
  /**
   * Cumulative ceiling on node executions for the WHOLE run, including every
   * loop iteration and every node inside a subworkflow. `MAX_SUBWORKFLOW_DEPTH`
   * bounds nesting but not total work: a shallow graph with a wide loop can run
   * unboundedly without ever nesting. Defaults to `DEFAULT_EXECUTION_BUDGET`.
   */
  executionBudget?: number;
  /** Cooperative cancellation; checked before each node starts. */
  signal?: AbortSignal;
  /**
   * ADR-040 A40-7 — emit the canonical execution map as the run happens.
   *
   * The engine does not know what consumes this: Core's reducer projects it,
   * the durable store persists it, CLI and Desktop render it. Optional so the
   * engine stays usable headless, and deliberately fire-and-forget — a
   * subscriber must never be able to fail a run by throwing.
   */
  emitExecution?: (event: GraphExecutionEmission) => void;
  /** Identity for the emitted execution; generated per run when absent. */
  executionId?: string;
}

/**
 * What the engine knows at emit time, in the shape A40-4's vocabulary expects.
 * The engine stays free of the protocol package; the caller maps this across.
 */
export interface GraphExecutionEmission {
  executionId: string;
  executionSequence: number;
  nodeId?: string;
  attempt?: number;
  iterationPath?: readonly number[];
  status?: string;
  edgeId?: string;
  edgeState?: 'active' | 'traversed' | 'skipped' | 'blocked';
  decision?: { kind: string; outcome: string; reasonCodes: readonly string[] };
}

export interface NodeRunRecord {
  id: string;
  type: string;
  status: 'ok' | 'skipped' | 'error';
  output?: unknown;
  /** For a branching node (condition/switch/classify/approval): which handle fired. */
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

interface RunOpts {
  /** Sub-workflow nesting depth (0 = top level). */
  depth: number;
  /** Stack of graph keys above this run, for direct-recursion detection. */
  stack: string[];
  /**
   * Node executions remaining for the WHOLE run, shared by reference with every
   * nested subworkflow. Held in an object so a child's spend is visible to the
   * parent — a per-run copy would let each nesting level start over, which is
   * how a "bounded" graph runs unboundedly.
   */
  budget: { remaining: number };
  /** Shared so a subworkflow's occurrences land in the SAME execution. */
  emit: (e: Omit<GraphExecutionEmission, 'executionId' | 'executionSequence'>) => void;
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

// ---------------------------------------------------------------------------
// array-node helpers (filter / sort / limit / aggregate / loop-foreach)
// ---------------------------------------------------------------------------

/** Coerce an arbitrary value to a list: arrays pass through; `{items|outputs}`
 *  unwrap; JSON-array strings parse; everything else wraps as a single item. */
function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.items)) return o.items as unknown[];
    if (Array.isArray(o.outputs)) return o.outputs as unknown[];
  }
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v) as unknown;
      if (Array.isArray(p)) return p;
      if (p && typeof p === 'object' && Array.isArray((p as { items?: unknown }).items)) return (p as { items: unknown[] }).items;
    } catch { /* not JSON — fall through */ }
  }
  return v === undefined || v === null ? [] : [v];
}

/** An array node's input: an explicit `data.source` template, else the single
 *  upstream output, else all upstream outputs. */
function resolveArrayInput(data: Record<string, unknown>, ctx: InterpContext, upstream: Array<{ id: string; output: unknown }>): unknown[] {
  if (data.source !== undefined) {
    const raw = typeof data.source === 'string' ? interpolate(data.source, ctx) : data.source;
    return asArray(raw);
  }
  if (upstream.length === 1) return asArray(upstream[0].output);
  if (upstream.length > 1) return upstream.map((u) => u.output);
  return [];
}

/** A scalar field of an item as a string (empty `field` → the item itself). */
function fieldStr(item: unknown, field: string): string {
  if (!field) {
    if (typeof item === 'string') return item;
    if (item == null) return '';
    return typeof item === 'object' ? JSON.stringify(item) : String(item);
  }
  if (item && typeof item === 'object') {
    const v = (item as Record<string, unknown>)[field];
    return v == null ? '' : (typeof v === 'string' ? v : String(v));
  }
  return '';
}

/** Best-effort parse of an LLM reply to a JSON object (whole string, then the
 *  outermost `{…}` slice). Empty object on failure — never throws. */
function safeJsonObject(raw: string): Record<string, unknown> {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const p = JSON.parse(s) as unknown;
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch { return null; }
  };
  const direct = tryParse(raw);
  if (direct) return direct;
  const open = raw.indexOf('{'), close = raw.lastIndexOf('}');
  if (open >= 0 && close > open) { const sliced = tryParse(raw.slice(open, close + 1)); if (sliced) return sliced; }
  return {};
}

/**
 * Execute a single node against a context (the building block, also exported for
 * the canvas's "test this node" affordance). `upstream` is the list of active
 * incoming nodes' outputs, used by `merge` and the array nodes. A `subworkflow`
 * node is NOT runnable here (it re-enters runGraph) — call runGraph instead.
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
    case 'switch': {
      const value = interpolate(String(data.value ?? ''), ctx);
      const cases = Array.isArray(data.cases) ? data.cases.map(String) : [];
      const branch = cases.includes(value) ? value : 'default';
      return { id: node.id, type: 'switch', status: 'ok', output: { value, branch }, branch };
    }
    case 'filter': {
      const arr = resolveArrayInput(data, ctx, upstream);
      const field = String(data.field ?? '');
      const op = String(data.op ?? 'truthy');
      const value = interpolate(String(data.value ?? ''), ctx);
      const items = arr.filter((it) => compare(fieldStr(it, field), op, value));
      return { id: node.id, type: 'filter', status: 'ok', output: { items, count: items.length } };
    }
    case 'sort': {
      const arr = resolveArrayInput(data, ctx, upstream).slice();
      const field = String(data.field ?? '');
      const desc = String(data.order ?? 'asc') === 'desc';
      const numeric = data.numeric === true;
      arr.sort((a, b) => {
        const av = fieldStr(a, field), bv = fieldStr(b, field);
        const c = numeric ? (Number(av) - Number(bv)) : av.localeCompare(bv);
        return desc ? -c : c;
      });
      return { id: node.id, type: 'sort', status: 'ok', output: { items: arr } };
    }
    case 'limit': {
      const arr = resolveArrayInput(data, ctx, upstream);
      const count = Math.max(0, Math.floor(Number(data.count ?? 0)) || 0);
      const items = arr.slice(0, count);
      return { id: node.id, type: 'limit', status: 'ok', output: { items, count: items.length } };
    }
    case 'aggregate': {
      const arr = resolveArrayInput(data, ctx, upstream);
      const field = String(data.field ?? '');
      const op = String(data.op ?? 'count');
      const nums = (): number[] => arr.map((it) => Number(fieldStr(it, field))).filter((n) => !Number.isNaN(n));
      let value: unknown;
      switch (op) {
        case 'count': value = arr.length; break;
        case 'sum': value = nums().reduce((s, n) => s + n, 0); break;
        case 'avg': { const ns = nums(); value = ns.length ? ns.reduce((s, n) => s + n, 0) / ns.length : 0; break; }
        case 'min': { const ns = nums(); value = ns.length ? Math.min(...ns) : null; break; }
        case 'max': { const ns = nums(); value = ns.length ? Math.max(...ns) : null; break; }
        case 'join': value = arr.map((it) => fieldStr(it, field)).join(String(data.separator ?? ', ')); break;
        case 'first': value = arr[0] ?? null; break;
        case 'last': value = arr[arr.length - 1] ?? null; break;
        default: value = arr.length;
      }
      return { id: node.id, type: 'aggregate', status: 'ok', output: { value, count: arr.length } };
    }
    case 'merge':
      return { id: node.id, type: 'merge', status: 'ok', output: { inputs: upstream.map((u) => u.output) } };
    case 'agent': {
      const prompt = interpolate(String(data.prompt ?? ''), ctx);
      const text = await deps.runAgent(prompt, node);
      return { id: node.id, type: 'agent', status: 'ok', output: { text } };
    }
    case 'loop': {
      const mode = String(data.mode ?? 'foreach');
      const maxIter = Math.max(1, Math.min(100, Math.floor(Number(data.maxIterations ?? 10)) || 10));
      if (mode === 'foreach') {
        const arr = resolveArrayInput(data, ctx, upstream).slice(0, maxIter);
        const outputs: string[] = [];
        for (let i = 0; i < arr.length; i++) {
          const itCtx: InterpContext = { nodes: ctx.nodes, vars: { ...ctx.vars, item: arr[i], index: i } };
          outputs.push(await deps.runAgent(interpolate(String(data.prompt ?? ''), itCtx), node));
        }
        return { id: node.id, type: 'loop', status: 'ok', output: { outputs, iterations: arr.length, items: arr } };
      }
      // refine: re-run the body up to maxIter, feeding the prior output as {{$vars.last}},
      // stopping early once the output contains the (optional) stop string.
      const stop = String(data.stopContains ?? '');
      let last = '';
      let iterations = 0;
      for (let i = 0; i < maxIter; i++) {
        iterations++;
        const itCtx: InterpContext = { nodes: ctx.nodes, vars: { ...ctx.vars, last, index: i } };
        last = await deps.runAgent(interpolate(String(data.prompt ?? ''), itCtx), node);
        if (stop && last.includes(stop)) break;
      }
      return { id: node.id, type: 'loop', status: 'ok', output: { text: last, iterations } };
    }
    case 'approval': {
      const summary = interpolate(String(data.summary ?? data.message ?? 'Approve this step?'), ctx);
      if (!deps.requestApproval) {
        if (!deps.allowUnattendedApproval) {
          return {
            id: node.id,
            type: 'approval',
            status: 'error',
            error: 'approval node reached with no approval port wired — refusing to self-approve. Wire requestApproval, or set allowUnattendedApproval to run this graph with no human present.',
          };
        }
        return {
          id: node.id,
          type: 'approval',
          status: 'ok',
          output: { approved: true, summary, unattended: true },
          branch: 'approved',
        };
      }
      const approved = await deps.requestApproval(node, summary);
      return { id: node.id, type: 'approval', status: 'ok', output: { approved, summary, unattended: false }, branch: approved ? 'approved' : 'rejected' };
    }
    case 'extract': {
      const instr = interpolate(String(data.prompt ?? data.instruction ?? ''), ctx);
      const fields = Array.isArray(data.fields) ? data.fields.map(String) : [];
      const ask = fields.length
        ? `${instr}\n\nReturn ONLY a JSON object with these keys: ${fields.join(', ')}.`
        : `${instr}\n\nReturn ONLY a JSON object.`;
      const raw = await deps.runAgent(ask, node);
      return { id: node.id, type: 'extract', status: 'ok', output: { fields: safeJsonObject(raw), raw } };
    }
    case 'classify': {
      const input = interpolate(String(data.input ?? data.prompt ?? ''), ctx);
      const labels = Array.isArray(data.labels) ? data.labels.map(String) : [];
      const ask = `Classify the following into exactly one of [${labels.join(', ')}]. Reply with only the label.\n\n${input}`;
      const raw = (await deps.runAgent(ask, node)).trim();
      const matched = labels.find((l) => raw.toLowerCase().includes(l.toLowerCase())) ?? (labels[0] ?? 'default');
      return { id: node.id, type: 'classify', status: 'ok', output: { label: matched, raw }, branch: matched };
    }
    case 'output': {
      const text = interpolate(String(data.template ?? ''), ctx);
      return { id: node.id, type: 'output', status: 'ok', output: { text } };
    }
    case 'subworkflow':
      throw new Error('subworkflow nodes run only inside runGraph (they re-enter the engine)');
    default:
      throw new Error(`unknown node type: ${(node as WorkflowNode).type}`);
  }
}

/** A stable key for recursion detection (id || name). */
function graphKey(graph: WorkflowGraph): string {
  return graph.id || graph.name || '';
}

/** Run a `subworkflow` node: load the referenced graph and re-enter runGraph
 *  under the depth + recursion guard, surfacing its finalOutput as this node's. */
async function runSubWorkflow(node: WorkflowNode, ctx: InterpContext, deps: GraphRunDeps, opts: RunOpts): Promise<NodeRunRecord> {
  const data = node.data ?? {};
  const ref = interpolate(String(data.workflowId ?? data.ref ?? data.name ?? ''), ctx).trim();
  if (!ref) return { id: node.id, type: 'subworkflow', status: 'error', error: 'no sub-workflow reference' };
  if (!deps.loadSubWorkflow) return { id: node.id, type: 'subworkflow', status: 'error', error: 'sub-workflows are not available (no loader wired)' };
  if (opts.depth + 1 > MAX_SUBWORKFLOW_DEPTH) return { id: node.id, type: 'subworkflow', status: 'error', error: `max sub-workflow depth (${MAX_SUBWORKFLOW_DEPTH}) exceeded` };
  if (opts.stack.includes(ref)) return { id: node.id, type: 'subworkflow', status: 'error', error: `sub-workflow recursion detected: ${ref}` };

  const sub = await deps.loadSubWorkflow(ref);
  if (!sub) return { id: node.id, type: 'subworkflow', status: 'error', error: `sub-workflow not found: ${ref}` };

  // Seed the child's run vars from this node's `inputs` (interpolated) over the parent vars.
  const inputs = data.inputs && typeof data.inputs === 'object' ? (data.inputs as Record<string, unknown>) : {};
  const seeded: Record<string, unknown> = { ...ctx.vars };
  for (const [k, v] of Object.entries(inputs)) seeded[k] = typeof v === 'string' ? interpolate(v, ctx) : v;

  // The child shares the parent's budget object, so nesting cannot reset it.
  const result = await runGraphInternal({ ...sub, vars: { ...(sub.vars ?? {}), ...seeded } }, deps, { depth: opts.depth + 1, stack: [...opts.stack, ref], budget: opts.budget, emit: opts.emit });
  if (!result.ok) return { id: node.id, type: 'subworkflow', status: 'error', error: `sub-workflow ${ref} failed: ${result.error ?? 'unknown'}`, output: { ok: false } };
  return { id: node.id, type: 'subworkflow', status: 'ok', output: { text: result.finalOutput ?? '', ok: true, nodes: result.nodes } };
}

/**
 * Run a whole graph. A node runs when it is a trigger OR has ≥1 active incoming
 * edge; a branching node (condition/switch/classify/approval) only activates the
 * outgoing edges whose handle matches its branch (handle-less edges always pass
 * through). A rejected `approval` halts its branch. The first node error fails
 * the run (fail-closed) and is reported.
 */
/**
 * A subscriber must not be able to fail a run. Observability that can break the
 * thing it observes is worse than no observability, because the failure then
 * looks like the workflow's.
 */
function makeEmitter(deps: GraphRunDeps, executionId: string): (e: Omit<GraphExecutionEmission, 'executionId' | 'executionSequence'>) => void {
  let sequence = 0;
  return (partial) => {
    if (!deps.emitExecution) return;
    sequence += 1;
    try {
      deps.emitExecution({ ...partial, executionId, executionSequence: sequence });
    } catch {
      /* an observer's failure is not the run's */
    }
  };
}

export async function runGraph(graph: WorkflowGraph, deps: GraphRunDeps): Promise<GraphRunResult> {
  const limit = deps.executionBudget ?? DEFAULT_EXECUTION_BUDGET;
  const executionId = deps.executionId ?? `graph-${graphKey(graph) || 'anon'}`;
  const emit = makeEmitter(deps, executionId);
  emit({ status: 'running' });
  const result = await runGraphInternal(graph, deps, {
    depth: 0,
    stack: [graphKey(graph)].filter(Boolean),
    budget: { remaining: Math.max(0, limit) },
    emit,
  });
  emit({ status: result.ok ? 'succeeded' : 'failed' });
  return result;
}

async function runGraphInternal(graph: WorkflowGraph, deps: GraphRunDeps, opts: RunOpts): Promise<GraphRunResult> {
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
    if (deps.signal?.aborted) {
      return { ok: false, order, nodes: records, finalOutput, error: 'run canceled' };
    }
    if (opts.budget.remaining <= 0) {
      return {
        ok: false,
        order,
        nodes: records,
        finalOutput,
        error: `execution budget exhausted (${deps.executionBudget ?? DEFAULT_EXECUTION_BUDGET} node executions) — the run was stopped rather than allowed to continue`,
      };
    }
    opts.budget.remaining -= 1;
    const upstream = (incoming.get(id) ?? [])
      .filter((e) => activeEdges.has(e.id))
      .map((e) => ({ id: e.source, output: ctx.nodes[e.source] }));
    try {
      const rec = node.type === 'subworkflow'
        ? await runSubWorkflow(node, ctx, deps, opts)
        : await runSingleNode(node, ctx, deps, upstream);
      records[id] = rec;
      ctx.nodes[id] = rec.output;
      opts.emit({
        nodeId: id,
        attempt: 1,
        iterationPath: opts.depth > 0 ? [opts.depth] : [],
        status: rec.status === 'ok' ? 'succeeded' : rec.status === 'skipped' ? 'skipped' : 'failed',
      });
      if (node.type === 'approval') {
        const approvedOutput = rec.output as { approved?: boolean; unattended?: boolean } | undefined;
        opts.emit({
          nodeId: id,
          decision: {
            kind: 'approval',
            outcome: approvedOutput?.approved ? 'approved' : 'rejected',
            reasonCodes: approvedOutput?.unattended ? ['unattended'] : [],
          },
        });
      }
      // a sub-workflow node that failed should fail the parent run (fail-closed)
      if (rec.status === 'error') return { ok: false, order, nodes: records, finalOutput, error: `node ${id} failed: ${rec.error ?? 'error'}` };
      if (node.type === 'output' && typeof (rec.output as { text?: unknown })?.text === 'string') {
        finalOutput = (rec.output as { text: string }).text;
      }
      // a rejected approval halts its branch (no outgoing activation)
      const approvalRejected = node.type === 'approval' && (rec.output as { approved?: boolean })?.approved === false;
      if (!approvalRejected) {
        for (const e of graph.edges) {
          if (e.source !== id) continue;
          // branch routing: a branching node's handled edges fire only on a match;
          // handle-less edges always pass through.
          if (rec.branch !== undefined && e.sourceHandle && e.sourceHandle !== rec.branch) continue;
          activeEdges.add(e.id);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      records[id] = { id, type: node.type, status: 'error', error: message };
      return { ok: false, order, nodes: records, finalOutput, error: `node ${id} failed: ${message}` };
    }
  }

  return { ok: true, order, nodes: records, finalOutput };
}
