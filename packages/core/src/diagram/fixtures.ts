/**
 * Reference diagrams, one per kind (ADR-056 D-A1). They are the validator's
 * conformance set, the renderer's golden inputs (A2), and the delta comparator's
 * base documents (A6) — so they stay small, valid under `showcase`, and carry
 * every optional feature at least once (boundary, main path, view, sources,
 * activation, lane, stage, typed states).
 */
import type {
  ArchitectureDiagram,
  DataflowDiagram,
  Diagram,
  DiagramKind,
  LifecycleDiagram,
  SequenceDiagram,
  WorkflowDiagram,
} from '@kinqs/brainrouter-types';

export const ARCHITECTURE_FIXTURE: ArchitectureDiagram = {
  schemaVersion: 1,
  kind: 'architecture',
  meta: {
    title: 'Checkout platform',
    qualityProfile: 'showcase',
    views: [{ id: 'happy-path', label: 'Happy path', focus: ['web', 'api', 'orders-db'], note: 'A browser order landing in the store.' }],
  },
  components: [
    { id: 'web', label: 'Web app', type: 'frontend', description: 'Browser storefront.' },
    { id: 'api', label: 'Orders API', type: 'backend', variant: 'emphasis', sources: [{ path: 'packages/core/src/review/service.ts', lines: [1, 40] }], evidence: 'authored' },
    { id: 'auth', label: 'Auth', type: 'security' },
    { id: 'orders-db', label: 'Orders DB', type: 'database' },
    { id: 'queue', label: 'Event bus', type: 'messagebus' },
    { id: 'payments', label: 'Payment provider', type: 'external', variant: 'dashed' },
  ],
  boundaries: [{ id: 'vpc', label: 'Private network', wraps: ['api', 'auth', 'orders-db', 'queue'], kind: 'network' }],
  connections: [
    { id: 'c1', label: 'HTTPS JSON', from: 'web', to: 'api', style: 'sync' },
    { id: 'c2', label: 'verify token', from: 'api', to: 'auth', style: 'sync' },
    { id: 'c3', label: 'read / write orders', from: 'api', to: 'orders-db', style: 'data' },
    { id: 'c4', label: 'order.created', from: 'api', to: 'queue', style: 'async' },
    { id: 'c5', label: 'charge', from: 'queue', to: 'payments', style: 'async' },
  ],
  mainPath: ['web', 'api', 'orders-db'],
};

export const WORKFLOW_FIXTURE: WorkflowDiagram = {
  schemaVersion: 1,
  kind: 'workflow',
  meta: { title: 'Plan, review, apply' },
  lanes: [{ id: 'agent', label: 'Agent' }, { id: 'human', label: 'Human' }],
  nodes: [
    { id: 'start', label: 'Request', shape: 'start', lane: 'agent' },
    { id: 'plan', label: 'Draft plan', shape: 'step', lane: 'agent' },
    { id: 'review', label: 'Approve?', shape: 'decision', lane: 'human' },
    { id: 'apply', label: 'Apply patch', shape: 'tool', lane: 'agent' },
    { id: 'done', label: 'Done', shape: 'end', lane: 'agent' },
  ],
  edges: [
    { id: 'e1', label: 'ready', from: 'start', to: 'plan' },
    { id: 'e2', label: 'proposal', from: 'plan', to: 'review' },
    { id: 'e3', label: 'approved', from: 'review', to: 'apply' },
    { id: 'e4', label: 'changes requested', from: 'review', to: 'plan' },
    { id: 'e5', label: 'applied', from: 'apply', to: 'done' },
  ],
  mainPath: ['start', 'plan', 'review', 'apply', 'done'],
};

export const SEQUENCE_FIXTURE: SequenceDiagram = {
  schemaVersion: 1,
  kind: 'sequence',
  meta: { title: 'Create order' },
  participants: [
    { id: 'client', label: 'Client', type: 'frontend' },
    { id: 'api', label: 'Orders API', type: 'backend' },
    { id: 'db', label: 'Orders DB', type: 'database' },
  ],
  messages: [
    { id: 'm1', label: 'POST /orders', from: 'client', to: 'api', kind: 'sync' },
    { id: 'm2', label: 'INSERT order', from: 'api', to: 'db', kind: 'sync' },
    { id: 'm3', label: 'ok', from: 'db', to: 'api', kind: 'return' },
    { id: 'm4', label: '201 Created', from: 'api', to: 'client', kind: 'return' },
  ],
  activations: [{ participant: 'api', fromMessage: 'm1', toMessage: 'm4' }],
};

export const DATAFLOW_FIXTURE: DataflowDiagram = {
  schemaVersion: 1,
  kind: 'dataflow',
  meta: { title: 'Events to dashboard' },
  stages: [{ id: 'ingest', label: 'Ingest' }, { id: 'transform', label: 'Transform' }, { id: 'serve', label: 'Serve' }],
  nodes: [
    { id: 'events', label: 'Event stream', stage: 'ingest', type: 'messagebus' },
    { id: 'raw', label: 'Raw store', stage: 'ingest', type: 'database' },
    { id: 'etl', label: 'Hourly ETL', stage: 'transform', type: 'backend' },
    { id: 'warehouse', label: 'Warehouse', stage: 'serve', type: 'database' },
    { id: 'dashboard', label: 'Dashboard', stage: 'serve', type: 'frontend' },
  ],
  flows: [
    { id: 'f1', label: 'append', from: 'events', to: 'raw' },
    { id: 'f2', label: 'batch hourly', from: 'raw', to: 'etl' },
    { id: 'f3', label: 'load', from: 'etl', to: 'warehouse' },
    { id: 'f4', label: 'query', from: 'warehouse', to: 'dashboard' },
  ],
};

export const LIFECYCLE_FIXTURE: LifecycleDiagram = {
  schemaVersion: 1,
  kind: 'lifecycle',
  meta: { title: 'Job lifecycle' },
  states: [
    { id: 'queued', label: 'Queued', type: 'initial' },
    { id: 'running', label: 'Running', type: 'active' },
    { id: 'waiting', label: 'Waiting for input', type: 'waiting' },
    { id: 'done', label: 'Done', type: 'terminal' },
    { id: 'failed', label: 'Failed', type: 'failure' },
  ],
  transitions: [
    { id: 't1', label: 'start', from: 'queued', to: 'running' },
    { id: 't2', label: 'needs input', from: 'running', to: 'waiting' },
    { id: 't3', label: 'input received', from: 'waiting', to: 'running' },
    { id: 't4', label: 'finish', from: 'running', to: 'done' },
    { id: 't5', label: 'error', from: 'running', to: 'failed' },
    { id: 't6', label: 'retry', from: 'failed', to: 'queued' },
  ],
};

export const DIAGRAM_FIXTURES: Record<DiagramKind, Diagram> = {
  architecture: ARCHITECTURE_FIXTURE,
  workflow: WORKFLOW_FIXTURE,
  sequence: SEQUENCE_FIXTURE,
  dataflow: DATAFLOW_FIXTURE,
  lifecycle: LIFECYCLE_FIXTURE,
};

/** A deep copy, so a test can mutate a fixture without poisoning the next one. */
export function diagramFixture(kind: DiagramKind): Diagram {
  return structuredClone(DIAGRAM_FIXTURES[kind]);
}
