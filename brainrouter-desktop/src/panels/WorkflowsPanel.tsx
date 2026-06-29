import React, { useCallback, useMemo, useState } from 'react';
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
};

const PALETTE: WfKind[] = ['trigger', 'agent', 'set', 'condition', 'merge', 'output'];

function defaultConfig(kind: WfKind): Record<string, unknown> {
  switch (kind) {
    case 'agent': return { prompt: 'Do the task using {{$vars.input}}' };
    case 'set': return { fields: { key: 'value' } };
    case 'condition': return { left: '{{$vars.x}}', op: '==', right: '1' };
    case 'output': return { template: '{{$nodes.agent.text}}' };
    default: return {};
  }
}

function summarize(kind: WfKind, config: Record<string, unknown>): string {
  switch (kind) {
    case 'agent': return String(config.prompt ?? '').slice(0, 60) || 'prompt…';
    case 'condition': return `${config.left ?? ''} ${config.op ?? '=='} ${config.right ?? ''}`;
    case 'output': return String(config.template ?? '').slice(0, 60) || 'template…';
    case 'set': return Object.keys((config.fields as Record<string, unknown>) ?? {}).join(', ') || 'fields…';
    default: return '';
  }
}

function WfNode({ data, selected }: NodeProps): React.ReactElement {
  const d = data as WfNodeData;
  return (
    <div className={`wf-node wf-node-${d.kind}${selected ? ' selected' : ''}`}>
      {d.kind !== 'trigger' ? <Handle type="target" position={Position.Left} /> : null}
      <div className="wf-node-kind">{KIND_LABEL[d.kind]}</div>
      <div className="wf-node-summary">{summarize(d.kind, d.config)}</div>
      {d.kind === 'condition' ? (
        <>
          <Handle type="source" position={Position.Right} id="true" style={{ top: '35%' }} />
          <Handle type="source" position={Position.Right} id="false" style={{ top: '65%' }} />
        </>
      ) : d.kind !== 'output' ? <Handle type="source" position={Position.Right} /> : null}
    </div>
  );
}

const NODE_TYPES = { wf: WfNode };

let seq = 0;
const nextId = (kind: WfKind): string => `${kind}_${++seq}`;

const STORE_KEY = 'br.workflows.v1';
type SavedGraphs = Record<string, { nodes: Node[]; edges: Edge[]; vars: Record<string, unknown> }>;
function loadSaved(): SavedGraphs {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}'); } catch { return {}; }
}
function persistSaved(all: SavedGraphs): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* quota — ignore */ }
}

function rfToGraph(nodes: Node[], edges: Edge[], vars: Record<string, unknown>): WorkflowGraph {
  return {
    name: 'canvas',
    vars,
    nodes: nodes.map((n) => ({ id: n.id, type: (n.data as WfNodeData).kind, data: (n.data as WfNodeData).config })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? undefined })),
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
  const [saved, setSaved] = useState<SavedGraphs>(() => loadSaved());
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
    const g = rfToGraph(nodes, edges, parsedVars);
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

  const doSave = (): void => {
    const all = { ...saved, [name.trim() || 'untitled']: { nodes, edges, vars: parsedVars } };
    persistSaved(all); setSaved(all);
  };
  const doLoad = (key: string): void => {
    const g = saved[key];
    if (!g) return;
    setNodes(g.nodes); setEdges(g.edges); setVars(JSON.stringify(g.vars ?? {}, null, 2)); setName(key); setSelectedId(null); setRun(null);
  };
  const doExport = (): void => {
    const stripped = stripSecretsForExport(rfToGraph(nodes, edges, parsedVars));
    void navigator.clipboard?.writeText(JSON.stringify(stripped, null, 2));
    setProblem('Secret-stripped graph copied to clipboard.');
  };

  return (
    <div className="scroll wf-panel">
      <div className="wf-toolbar">
        <input className="filter" style={{ maxWidth: 160 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="workflow name" />
        <button className="sched-add-btn" onClick={doSave}>Save</button>
        <select className="filter" style={{ maxWidth: 140 }} value="" onChange={(e) => e.target.value && doLoad(e.target.value)}>
          <option value="">Load…</option>
          {Object.keys(saved).map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <button className="seg-toggle" onClick={doValidate}>Validate</button>
        <button className="sched-add-btn" onClick={doTestRun}>Test run</button>
        <button className="seg-toggle" onClick={doExport}>Export</button>
      </div>

      <div className="wf-palette">
        <span className="wf-palette-label">Add node:</span>
        {PALETTE.map((k) => <button key={k} className="seg-toggle" onClick={() => addNode(k)}>{KIND_LABEL[k]}</button>)}
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
            {selected ? <NodeConfig node={selected} onPatch={patchConfig} onDelete={() => { setNodes((nds) => nds.filter((n) => n.id !== selectedId)); setSelectedId(null); }} /> : (
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

function NodeConfig({ node, onPatch, onDelete }: { node: Node; onPatch: (p: Record<string, unknown>) => void; onDelete: () => void }): React.ReactElement {
  const d = node.data as WfNodeData;
  const cfg = d.config;
  return (
    <div className="wf-config">
      <div className="wf-section">{KIND_LABEL[d.kind]} · <code>{node.id}</code></div>
      {d.kind === 'agent' ? (
        <label className="wf-field">Prompt
          <textarea className="wf-textarea" rows={4} value={String(cfg.prompt ?? '')} onChange={(e) => onPatch({ prompt: e.target.value })} />
        </label>
      ) : null}
      {d.kind === 'output' ? (
        <label className="wf-field">Template
          <textarea className="wf-textarea" rows={4} value={String(cfg.template ?? '')} onChange={(e) => onPatch({ template: e.target.value })} />
        </label>
      ) : null}
      {d.kind === 'condition' ? (
        <div className="wf-cond">
          <input className="filter" value={String(cfg.left ?? '')} onChange={(e) => onPatch({ left: e.target.value })} placeholder="left" />
          <select className="filter" value={String(cfg.op ?? '==')} onChange={(e) => onPatch({ op: e.target.value })}>
            {['==', '!=', 'contains', '>', '<', 'truthy'].map((o) => <option key={o} value={o}>{o}</option>)}
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
      {d.kind === 'trigger' || d.kind === 'merge' ? <div className="wf-hint">No configuration.</div> : null}
      <button className="icon-btn wf-delete" onClick={onDelete}>Delete node</button>
    </div>
  );
}
