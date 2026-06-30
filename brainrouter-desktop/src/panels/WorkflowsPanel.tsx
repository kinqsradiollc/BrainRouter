import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  validateGraph,
  stripSecretsForExport,
  type WorkflowGraph,
  type WorkflowNodeType,
} from '@kinqs/brainrouter-core/dist/workflow/graph.js';
import { runGraph, type GraphRunResult } from '@kinqs/brainrouter-core/dist/workflow/graphEngine.js';
import type { SavedWorkflowMeta } from '@kinqs/brainrouter-core/dist/workflow/graphStore.js';
import { hostQuery } from '../lib/hostQuery.js';

/**
 * Visual workflow canvas (§7 L1) — an n8n-style node editor over the L2 graph
 * engine. Self-contained: the graph lives in local state + localStorage, the
 * "Test run" exercises the real engine with a stub agent (real task_agent wiring
 * is L4). Mirrors AtlasPanel's React Flow setup + the panel CSS idioms.
 */

type WfKind = WorkflowNodeType;

interface WfNodeData extends Record<string, unknown> {
  kind: WfKind;
  config: Record<string, unknown>;
}

const KIND_LABEL: Record<WfKind, string> = {
  trigger: 'Trigger',
  agent: 'AI Agent',
  set: 'Set fields',
  condition: 'Condition',
  merge: 'Merge',
  output: 'Output',
  // §7 L3 — advanced nodes
  switch: 'Switch',
  filter: 'Filter',
  sort: 'Sort',
  limit: 'Limit',
  aggregate: 'Aggregate',
  loop: 'Loop',
  approval: 'Approval',
  extract: 'Extract',
  classify: 'Classify',
  subworkflow: 'Sub-workflow',
};

const PALETTE: WfKind[] = ['trigger', 'agent', 'set', 'condition', 'merge', 'output'];
const PALETTE_L3: WfKind[] = ['switch', 'filter', 'sort', 'limit', 'aggregate', 'loop', 'approval', 'extract', 'classify', 'subworkflow'];

// Each palette chip carries the dot colour of the node it adds — so the palette
// reads as a legend for the canvas (mirrors Atlas's category pills).
const KIND_COLOR: Partial<Record<WfKind, string>> = {
  trigger: 'var(--ok)', agent: 'var(--accent)', output: '#61afef',
  condition: '#e5c07b', set: '#c678dd', merge: '#56b6c2', approval: '#e5c07b',
  switch: '#61afef', classify: '#c678dd',
};
const kindColor = (k: WfKind): string => KIND_COLOR[k] ?? 'var(--accent)';

function defaultConfig(kind: WfKind): Record<string, unknown> {
  switch (kind) {
    case 'agent': return { prompt: 'Do the task using {{$vars.input}}' };
    case 'set': return { fields: { key: 'value' } };
    case 'condition': return { left: '{{$vars.x}}', op: '==', right: '1' };
    case 'output': return { template: '{{$nodes.agent.text}}' };
    case 'switch': return { value: '{{$vars.tier}}', cases: ['free', 'pro'] };
    case 'filter': return { source: '[]', field: 'score', op: '>', value: '5' };
    case 'sort': return { source: '[]', field: 'score', order: 'desc', numeric: true };
    case 'limit': return { source: '[]', count: 10 };
    case 'aggregate': return { source: '[]', op: 'count', field: '' };
    case 'loop': return { mode: 'foreach', source: '[]', prompt: 'Process {{$vars.item}}', maxIterations: 10, stopContains: '' };
    case 'approval': return { summary: 'Approve this step?' };
    case 'extract': return { prompt: 'Extract parameters from {{$vars.input}}', fields: ['name'] };
    case 'classify': return { input: '{{$vars.question}}', labels: ['billing', 'technical'] };
    case 'subworkflow': return { workflowId: '', inputs: {} };
    default: return {};
  }
}

function summarize(kind: WfKind, config: Record<string, unknown>): string {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  switch (kind) {
    case 'agent': return String(config.prompt ?? '').slice(0, 60) || 'prompt…';
    case 'condition': return `${config.left ?? ''} ${config.op ?? '=='} ${config.right ?? ''}`;
    case 'output': return String(config.template ?? '').slice(0, 60) || 'template…';
    case 'set': return Object.keys((config.fields as Record<string, unknown>) ?? {}).join(', ') || 'fields…';
    case 'switch': return `${config.value ?? ''} ∈ [${arr(config.cases).join(', ')}]`;
    case 'filter': return `${config.field ?? ''} ${config.op ?? ''} ${config.value ?? ''}`.trim() || 'filter…';
    case 'sort': return `by ${config.field ?? '?'} ${config.order ?? 'asc'}`;
    case 'limit': return `first ${config.count ?? 0}`;
    case 'aggregate': return `${config.op ?? 'count'}(${config.field ?? ''})`;
    case 'loop': return `${config.mode ?? 'foreach'} ·≤${config.maxIterations ?? 10}`;
    case 'approval': return String(config.summary ?? '').slice(0, 60) || 'approve…';
    case 'extract': return arr(config.fields).join(', ') || 'fields…';
    case 'classify': return `→ [${arr(config.labels).join(', ')}]`;
    case 'subworkflow': return String(config.workflowId ?? '') || 'pick a workflow…';
    default: return '';
  }
}

/**
 * The outgoing handles for a node's kind. `null` → one unlabeled source handle;
 * `[]` → terminal (no source); a list → one labeled handle per branch, evenly
 * spaced down the right edge. Branch ids must match the engine's `rec.branch`.
 */
function sourceHandlesFor(kind: WfKind, config: Record<string, unknown>): string[] | null {
  switch (kind) {
    case 'output': return [];
    case 'condition': return ['true', 'false'];
    case 'switch': { const c = Array.isArray(config.cases) ? config.cases.map(String) : []; return [...c, 'default']; }
    case 'classify': { const l = Array.isArray(config.labels) ? config.labels.map(String) : []; return l.length ? l : ['default']; }
    case 'approval': return ['approved', 'rejected'];
    default: return null;
  }
}

function WfNode({ data, selected }: NodeProps): React.ReactElement {
  const d = data as WfNodeData;
  const handles = sourceHandlesFor(d.kind, d.config);
  return (
    <div className={`wf-node wf-node-${d.kind}${selected ? ' selected' : ''}`}>
      {d.kind !== 'trigger' ? <Handle type="target" position={Position.Left} /> : null}
      <div className="wf-node-kind">{KIND_LABEL[d.kind]}</div>
      <div className="wf-node-summary">{summarize(d.kind, d.config)}</div>
      {handles === null ? <Handle type="source" position={Position.Right} /> : handles.map((h, i) => {
        const top = `${((i + 1) / (handles.length + 1)) * 100}%`;
        return (
          <React.Fragment key={h}>
            <Handle type="source" position={Position.Right} id={h} style={{ top }} />
            {handles.length > 1 ? <span className="wf-handle-label" style={{ top }}>{h}</span> : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}

const NODE_TYPES = { wf: WfNode };

let seq = 0;
const nextId = (kind: WfKind): string => `${kind}_${++seq}`;

function rfToGraph(name: string, nodes: Node[], edges: Edge[], vars: Record<string, unknown>): WorkflowGraph {
  return {
    name,
    vars,
    nodes: nodes.map((n) => ({ id: n.id, type: (n.data as WfNodeData).kind, data: (n.data as WfNodeData).config, position: n.position })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? undefined })),
  };
}

/** Restore React Flow nodes/edges from a saved WorkflowGraph (positions kept, or auto-laid-out). */
function graphToRf(graph: WorkflowGraph): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((n, i) => ({
      id: n.id,
      type: 'wf',
      position: n.position ?? { x: 80 + (i % 4) * 190, y: 80 + Math.floor(i / 4) * 120 },
      data: { kind: n.type, config: n.data ?? {} },
    })),
    edges: graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}) })),
  };
}

const SEED_NODES: Node[] = [
  { id: 'trigger_seed', type: 'wf', position: { x: 40, y: 120 }, data: { kind: 'trigger', config: {} } },
  { id: 'agent_seed', type: 'wf', position: { x: 280, y: 120 }, data: { kind: 'agent', config: { prompt: 'Summarize {{$vars.topic}}' } } },
  { id: 'output_seed', type: 'wf', position: { x: 540, y: 120 }, data: { kind: 'output', config: { template: 'Result: {{$nodes.agent_seed.text}}' } } },
];
const SEED_EDGES: Edge[] = [
  { id: 'e_seed_1', source: 'trigger_seed', target: 'agent_seed' },
  { id: 'e_seed_2', source: 'agent_seed', target: 'output_seed' },
];

export interface WorkflowsPanelProps {
  /** Optional: run a graph against the real agent (L4); when absent, Test run uses a stub. */
  onRun?: (graph: WorkflowGraph) => void;
}

export function WorkflowsPanel(_props: WorkflowsPanelProps): React.ReactElement {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(SEED_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(SEED_EDGES);
  const [vars, setVars] = useState<string>('{\n  "topic": "vector databases"\n}');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState('untitled');
  const [saved, setSaved] = useState<SavedWorkflowMeta[]>([]);
  const [run, setRun] = useState<GraphRunResult | null>(null);
  const [problem, setProblem] = useState<string>('');

  const onConnect = useCallback(
    (c: Connection) => setEdges((eds) => addEdge({ ...c, id: `e_${++seq}` }, eds)),
    [setEdges],
  );

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  const addNode = (kind: WfKind): void => {
    const id = nextId(kind);
    setNodes((nds) => [
      ...nds,
      { id, type: 'wf', position: { x: 120 + Math.round((nds.length % 4) * 60), y: 260 + Math.round((nds.length % 5) * 40) }, data: { kind, config: defaultConfig(kind) } },
    ]);
    setSelectedId(id);
  };

  const patchConfig = (patch: Record<string, unknown>): void => {
    if (!selectedId) return;
    setNodes((nds) => nds.map((n) => n.id === selectedId
      ? { ...n, data: { ...(n.data as WfNodeData), config: { ...(n.data as WfNodeData).config, ...patch } } }
      : n));
  };

  const parsedVars = useMemo<Record<string, unknown>>(() => {
    try { return JSON.parse(vars); } catch { return {}; }
  }, [vars]);

  const doValidate = (): WorkflowGraph | null => {
    const g = rfToGraph(name.trim() || 'untitled', nodes, edges, parsedVars);
    const v = validateGraph(g);
    setProblem(v.ok ? '' : v.errors.join(' · '));
    return v.ok ? g : null;
  };

  const doTestRun = async (): Promise<void> => {
    const g = doValidate();
    if (!g) { setRun(null); return; }
    const result = await runGraph(g, { runAgent: async (prompt) => `⟦stub agent⟧ ${prompt.slice(0, 80)}` });
    setRun(result);
  };

  const refreshSaved = useCallback(async () => {
    setSaved((await hostQuery<SavedWorkflowMeta[]>('workflow-list')) ?? []);
  }, []);
  useEffect(() => { void refreshSaved(); }, [refreshSaved]);

  const doSave = async (): Promise<void> => {
    const graph = rfToGraph(name.trim() || 'untitled', nodes, edges, parsedVars);
    const res = await hostQuery<{ id?: string }>('workflow-save', { graph });
    if (res?.id) { setProblem(`Saved "${graph.name}" to the project.`); void refreshSaved(); }
    else setProblem('Save failed.');
  };
  const doLoad = async (id: string): Promise<void> => {
    const graph = await hostQuery<WorkflowGraph>('workflow-load', { id });
    if (!graph) { setProblem(`Could not load "${id}".`); return; }
    const rf = graphToRf(graph);
    setNodes(rf.nodes); setEdges(rf.edges); setVars(JSON.stringify(graph.vars ?? {}, null, 2)); setName(graph.name ?? id); setSelectedId(null); setRun(null); setProblem('');
  };
  const doExport = (): void => {
    const stripped = stripSecretsForExport(rfToGraph(name.trim() || 'untitled', nodes, edges, parsedVars));
    void navigator.clipboard?.writeText(JSON.stringify(stripped, null, 2));
    setProblem('Secret-stripped graph copied to clipboard.');
  };

  return (
    <div className="scroll wf-panel">
      <div className="wf-toolbar">
        <input className="toolbar-input wf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="workflow name" />
        <select className="toolbar-input wf-load" value="" onChange={(e) => { if (e.target.value) void doLoad(e.target.value); }}>
          <option value="">Load…</option>
          {saved.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <span className="wf-spacer" />
        <button className="btn" onClick={doValidate}>Validate</button>
        <button className="btn" onClick={() => void doSave()}>Save</button>
        <button className="btn primary" onClick={doTestRun}>Test run</button>
        <button className="btn" onClick={doExport}>Export</button>
      </div>

      <div className="wf-palette">
        <span className="wf-palette-label">Add node</span>
        {PALETTE.map((k) => (
          <button key={k} className="wf-add" onClick={() => addNode(k)} title={`Add a ${KIND_LABEL[k]} node`}>
            <span className="wf-add-dot" style={{ background: kindColor(k) }} />{KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="wf-palette">
        <span className="wf-palette-label">Advanced</span>
        {PALETTE_L3.map((k) => (
          <button key={k} className="wf-add" onClick={() => addNode(k)} title={`Add a ${KIND_LABEL[k]} node`}>
            <span className="wf-add-dot" style={{ background: kindColor(k) }} />{KIND_LABEL[k]}
          </button>
        ))}
      </div>

      {problem ? <div className="wf-problem">{problem}</div> : null}

      <div className="wf-body">
        <div className="wf-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_e, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="var(--border)" gap={20} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable maskColor="rgba(0,0,0,0.55)" style={{ width: 120, height: 80, background: 'var(--surface)', border: '1px solid var(--border)' }} />
          </ReactFlow>
        </div>

        <div className="wf-side">
          <div className="wf-inspector">
            {selected ? <NodeConfig node={selected} saved={saved} onPatch={patchConfig} onDelete={() => { setNodes((nds) => nds.filter((n) => n.id !== selectedId)); setSelectedId(null); }} /> : (
              <div className="wf-inspector-empty">
                <div className="wf-section">Run variables</div>
                <textarea className="wf-textarea" value={vars} onChange={(e) => setVars(e.target.value)} rows={5} spellCheck={false} />
                <div className="wf-hint">Select a node to edit it. Reference values with <code>{'{{$vars.x}}'}</code> and <code>{'{{$nodes.id.text}}'}</code>.</div>
              </div>
            )}
          </div>

          {run ? (
            <div className="wf-run">
              <div className="wf-section">Run {run.ok ? '✓' : '✗'}</div>
              {run.error ? <div className="wf-problem">{run.error}</div> : null}
              {run.order.map((id) => {
                const rec = run.nodes[id];
                return <div key={id} className={`wf-run-row wf-run-${rec.status}`}>
                  <span className="wf-run-id">{id}</span>
                  <span className="wf-run-status">{rec.status}{rec.branch ? ` → ${rec.branch}` : ''}</span>
                </div>;
              })}
              {run.finalOutput ? <pre className="wf-run-output">{run.finalOutput}</pre> : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="sched-note">Workflows run on BrainRouter's orchestration engine. Test run uses a stub agent; wiring AI Agent nodes to the real <code>task_agent</code> + saving to <code>.brainrouter/workflows/</code> is the next step.</div>
    </div>
  );
}

const FILTER_OPS = ['==', '!=', 'contains', '>', '<', 'truthy'];
const AGG_OPS = ['count', 'sum', 'avg', 'min', 'max', 'join', 'first', 'last'];
const csv = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(', ') : '');
const toArr = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

function NodeConfig({ node, saved, onPatch, onDelete }: { node: Node; saved: SavedWorkflowMeta[]; onPatch: (p: Record<string, unknown>) => void; onDelete: () => void }): React.ReactElement {
  const d = node.data as WfNodeData;
  const cfg = d.config;
  const str = (k: string): string => String(cfg[k] ?? '');
  const text = (k: string, label: string, rows = 4): React.ReactElement => (
    <label className="wf-field">{label}
      <textarea className="wf-textarea" rows={rows} value={str(k)} onChange={(e) => onPatch({ [k]: e.target.value })} />
    </label>
  );
  const line = (k: string, label: string, placeholder = ''): React.ReactElement => (
    <label className="wf-field">{label}
      <input className="filter" value={str(k)} onChange={(e) => onPatch({ [k]: e.target.value })} placeholder={placeholder} />
    </label>
  );
  return (
    <div className="wf-config">
      <div className="wf-section">{KIND_LABEL[d.kind]} · <code>{node.id}</code></div>
      {d.kind === 'agent' ? text('prompt', 'Prompt') : null}
      {d.kind === 'output' ? text('template', 'Template') : null}
      {d.kind === 'condition' ? (
        <div className="wf-cond">
          <input className="filter" value={String(cfg.left ?? '')} onChange={(e) => onPatch({ left: e.target.value })} placeholder="left" />
          <select className="filter" value={String(cfg.op ?? '==')} onChange={(e) => onPatch({ op: e.target.value })}>
            {FILTER_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <input className="filter" value={String(cfg.right ?? '')} onChange={(e) => onPatch({ right: e.target.value })} placeholder="right" />
        </div>
      ) : null}
      {d.kind === 'set' ? (
        <label className="wf-field">Fields (JSON)
          <textarea className="wf-textarea" rows={4} value={JSON.stringify(cfg.fields ?? {}, null, 2)}
            onChange={(e) => { try { onPatch({ fields: JSON.parse(e.target.value) }); } catch { /* keep typing */ } }} />
        </label>
      ) : null}
      {d.kind === 'switch' ? (
        <>
          {line('value', 'Value', '{{$vars.tier}}')}
          <label className="wf-field">Cases (comma-separated)
            <input className="filter" value={csv(cfg.cases)} onChange={(e) => onPatch({ cases: toArr(e.target.value) })} placeholder="free, pro" />
          </label>
          <div className="wf-hint">Routes to the matching case handle, else <code>default</code>.</div>
        </>
      ) : null}
      {d.kind === 'filter' ? (
        <>
          {line('source', 'Source (array or {{$nodes.id.items}})', '[]')}
          {line('field', 'Field', 'score')}
          <label className="wf-field">Operator
            <select className="filter" value={String(cfg.op ?? '==')} onChange={(e) => onPatch({ op: e.target.value })}>
              {FILTER_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          {line('value', 'Value', '5')}
        </>
      ) : null}
      {d.kind === 'sort' ? (
        <>
          {line('source', 'Source', '[]')}
          {line('field', 'Field', 'score')}
          <label className="wf-field">Order
            <select className="filter" value={String(cfg.order ?? 'asc')} onChange={(e) => onPatch({ order: e.target.value })}>
              {['asc', 'desc'].map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          <label className="wf-check"><input type="checkbox" checked={cfg.numeric === true} onChange={(e) => onPatch({ numeric: e.target.checked })} /> Numeric</label>
        </>
      ) : null}
      {d.kind === 'limit' ? (
        <>
          {line('source', 'Source', '[]')}
          <label className="wf-field">Count
            <input className="filter" type="number" value={Number(cfg.count ?? 0)} onChange={(e) => onPatch({ count: Number(e.target.value) })} />
          </label>
        </>
      ) : null}
      {d.kind === 'aggregate' ? (
        <>
          {line('source', 'Source', '[]')}
          <label className="wf-field">Operation
            <select className="filter" value={String(cfg.op ?? 'count')} onChange={(e) => onPatch({ op: e.target.value })}>
              {AGG_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          {line('field', 'Field', '')}
          {String(cfg.op) === 'join' ? line('separator', 'Separator', ', ') : null}
        </>
      ) : null}
      {d.kind === 'loop' ? (
        <>
          <label className="wf-field">Mode
            <select className="filter" value={String(cfg.mode ?? 'foreach')} onChange={(e) => onPatch({ mode: e.target.value })}>
              {['foreach', 'refine'].map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          {String(cfg.mode ?? 'foreach') === 'foreach' ? line('source', 'Items (array)', '[]') : null}
          {text('prompt', 'Body prompt', 3)}
          <label className="wf-field">Max iterations
            <input className="filter" type="number" value={Number(cfg.maxIterations ?? 10)} onChange={(e) => onPatch({ maxIterations: Number(e.target.value) })} />
          </label>
          {String(cfg.mode) === 'refine' ? line('stopContains', 'Stop when output contains', 'DONE') : null}
          <div className="wf-hint">foreach: <code>{'{{$vars.item}}'}</code>/<code>{'{{$vars.index}}'}</code>. refine: <code>{'{{$vars.last}}'}</code>.</div>
        </>
      ) : null}
      {d.kind === 'approval' ? text('summary', 'Summary shown to the approver', 3) : null}
      {d.kind === 'extract' ? (
        <>
          {text('prompt', 'Instruction', 3)}
          <label className="wf-field">Fields (comma-separated)
            <input className="filter" value={csv(cfg.fields)} onChange={(e) => onPatch({ fields: toArr(e.target.value) })} placeholder="name, email" />
          </label>
        </>
      ) : null}
      {d.kind === 'classify' ? (
        <>
          {text('input', 'Input', 3)}
          <label className="wf-field">Labels (comma-separated)
            <input className="filter" value={csv(cfg.labels)} onChange={(e) => onPatch({ labels: toArr(e.target.value) })} placeholder="billing, technical" />
          </label>
          <div className="wf-hint">Routes to the chosen-label handle.</div>
        </>
      ) : null}
      {d.kind === 'subworkflow' ? (
        <>
          <label className="wf-field">Workflow
            <select className="filter" value={str('workflowId')} onChange={(e) => onPatch({ workflowId: e.target.value })}>
              <option value="">pick a saved workflow…</option>
              {saved.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label className="wf-field">Inputs (JSON)
            <textarea className="wf-textarea" rows={3} value={JSON.stringify(cfg.inputs ?? {}, null, 2)}
              onChange={(e) => { try { onPatch({ inputs: JSON.parse(e.target.value) }); } catch { /* keep typing */ } }} />
          </label>
        </>
      ) : null}
      {d.kind === 'trigger' || d.kind === 'merge' ? <div className="wf-hint">No configuration.</div> : null}
      <button className="icon-btn wf-delete" onClick={onDelete}>Delete node</button>
    </div>
  );
}
