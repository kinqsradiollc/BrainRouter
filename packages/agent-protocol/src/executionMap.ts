/**
 * ADR-040 D7/A40-4 — one execution map, in dependency-free wire vocabulary.
 *
 * This module is deliberately inert: types, closed status sets, identity
 * helpers, and bounds. Core owns the projector/reducer and every transition;
 * nothing here reaches into a runtime, and nothing here decides anything.
 *
 * Two ideas carry most of the weight:
 *
 *   1. A logical NODE and one ATTEMPT of that node are different records. Fold
 *      them together and a retry overwrites the evidence of the failure that
 *      caused it — the map then shows a green run whose first attempt is gone.
 *   2. `iterationPath` is an ARRAY. A scalar iteration counter collapses nested
 *      loops and subworkflows onto each other, so two different places in a run
 *      claim the same identity.
 */

/** Non-terminal run states. */
export const OPEN_EXECUTION_STATUSES = ['planned', 'running', 'waiting-approval'] as const;
/** Terminal run states. A terminal execution never returns to running. */
export const TERMINAL_EXECUTION_STATUSES = [
  'succeeded', 'degraded', 'failed', 'blocked', 'cancelled', 'interrupted',
] as const;

export type OpenExecutionStatus = typeof OPEN_EXECUTION_STATUSES[number];
export type TerminalExecutionStatus = typeof TERMINAL_EXECUTION_STATUSES[number];
export type ExecutionStatus = OpenExecutionStatus | TerminalExecutionStatus;

/** Occurrences additionally permit `skipped` — a node that never ran at all. */
export type NodeOccurrenceStatus = ExecutionStatus | 'skipped';

/**
 * Snapshot completeness is reported SEPARATELY from run status, so a host that
 * is missing events says so instead of inventing a runtime state to cover it.
 * "I do not know" and "it failed" are different facts about a run.
 */
export type SnapshotCompleteness = 'complete' | 'gapped' | 'unavailable';

export type ExecutionScopeKind = 'turn' | 'goal' | 'stage' | 'workflow' | 'subworkflow';
export type ExecutionTopology = 'direct' | 'profile-stages' | 'phase-plan' | 'workflow-graph';
export type SelectionSource =
  | 'explicit-user'
  | 'workspace-default'
  | 'inherited-goal'
  | 'adaptive'
  | 'fallback-direct';

export type NodeExecutorKind = 'agent-loop' | 'tool' | 'approval' | 'control' | 'subworkflow';

export type EdgeKind =
  | 'dependency' | 'branch' | 'fan-out' | 'fan-in'
  | 'loop-back' | 'continuation' | 'subworkflow' | 'failure';

export type EdgeTraversalState = 'active' | 'traversed' | 'skipped' | 'blocked';

export type DecisionKind =
  | 'approval' | 'guard' | 'retry' | 'rollback' | 'degradation' | 'selection';

export const EXECUTION_MAP_SCHEMA_VERSION = 1;

export interface ExecutionUsage {
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
  wallClockMs: number;
}

/** A run. Usage and budgets are numbers, never free text. */
export interface ExecutionRecord {
  schemaVersion: number;
  executionId: string;
  parentExecutionId?: string;
  scopeKind: ExecutionScopeKind;
  sessionKey: string;
  topology: ExecutionTopology;
  workspaceProfileId: string;
  planProfileId?: string;
  strategyId?: string;
  selectionSource: SelectionSource;
  definitionId?: string;
  definitionVersion?: string;
  definitionHash?: string;
  status: ExecutionStatus;
  startedAt: string;
  endedAt?: string;
  inheritedBudget: number | null;
  usage: ExecutionUsage;
  meteringState: 'metered' | 'unmetered' | 'unknown';
  selectionSignals: readonly string[];
  selectionDiagnostics: readonly string[];
  terminalReasonCodes: readonly string[];
}

/** The logical shape of the plan — one record per node, however often it runs. */
export interface ExecutionLogicalNode {
  nodeId: string;
  parentNodeId?: string;
  kind: string;
  /**
   * Display text that came from a trusted definition/catalog or a sanitized
   * user-authored definition. NEVER a model-generated summary: this view is
   * durable and is read back as fact.
   */
  boundedLabel: string;
  executorKind: NodeExecutorKind;
  roleId?: string;
  skillIds: readonly string[];
  declaredLimits: Readonly<Record<string, number>>;
}

/** One attempt/iteration of a logical node. */
export interface ExecutionNodeOccurrence {
  nodeExecutionId: string;
  nodeId: string;
  parentNodeExecutionId?: string;
  attempt: number;
  /** Nested loops/subworkflows do not collapse into one scalar. */
  iterationPath: readonly number[];
  status: NodeOccurrenceStatus;
  childSessionIds: readonly string[];
  startedAt?: string;
  endedAt?: string;
  usage: ExecutionUsage;
  terminalReasonCodes: readonly string[];
}

export interface ExecutionDeclaredEdge {
  edgeId: string;
  from: string;
  to: string;
  kind: EdgeKind;
  boundedLabel?: string;
}

export interface ExecutionEdgeTraversal {
  edgeTraversalId: string;
  edgeId: string;
  fromNodeExecutionId: string;
  toNodeExecutionId?: string;
  state: EdgeTraversalState;
  sequence: number;
}

/** Typed outcomes and safe reason codes — never chain-of-thought. */
export interface ExecutionDecision {
  decisionId: string;
  kind: DecisionKind;
  nodeExecutionId?: string;
  outcome: string;
  reasonCodes: readonly string[];
  decidedAt: string;
}

/**
 * An execution event carries its OWN identity and ordering, independent of the
 * host transport sequence. A host that reconnects, replays, or multiplexes must
 * not be the thing that defines run order.
 */
export interface ExecutionEvent {
  schemaVersion: number;
  eventId: string;
  executionId: string;
  executionSequence: number;
  sessionKey: string;
  /**
   * ADR-040 A40-9 goal-continuation / A40-5 goal grouping — the goal this run
   * belongs to, when it was launched under an active goal. Absent for a normal
   * no-goal turn; a run is never RETROFITTED into a goal, so the reducer groups
   * only what was emitted with the link already present.
   */
  goalId?: string;
  emittedAt: string;
  causationEventId?: string;
  nodeExecutionId?: string;
  payload: unknown;
}

const OPEN = new Set<string>(OPEN_EXECUTION_STATUSES);
const TERMINAL = new Set<string>(TERMINAL_EXECUTION_STATUSES);

export function isOpenExecutionStatus(value: string): value is OpenExecutionStatus {
  return OPEN.has(value);
}

export function isTerminalExecutionStatus(value: string): value is TerminalExecutionStatus {
  return TERMINAL.has(value);
}

export function isExecutionStatus(value: string): value is ExecutionStatus {
  return OPEN.has(value) || TERMINAL.has(value);
}

export function isNodeOccurrenceStatus(value: string): value is NodeOccurrenceStatus {
  return isExecutionStatus(value) || value === 'skipped';
}

/**
 * A terminal state is final. Callers ask before writing so a late or replayed
 * event cannot resurrect a finished run — which is how a failed execution comes
 * back as `running` and never ends.
 */
export function canTransitionExecutionStatus(from: ExecutionStatus, to: ExecutionStatus): boolean {
  if (isTerminalExecutionStatus(from)) return from === to;
  return isExecutionStatus(to);
}

/** Bounds so one pathological run cannot make a snapshot unreadable or unbounded. */
export const EXECUTION_MAP_BOUNDS = {
  maxBoundedLabelChars: 120,
  maxReasonCodes: 16,
  maxReasonCodeChars: 64,
  maxIterationPathDepth: 8,
  maxSelectionSignals: 32,
} as const;

/**
 * Clamp a label to its bound and strip anything that would let it stop being a
 * label. Newlines and control characters turn one row into several, and this
 * text is rendered in a list where that reads as extra runs.
 */
export function boundLabel(raw: string, max = EXECUTION_MAP_BOUNDS.maxBoundedLabelChars): string {
  // eslint-disable-next-line no-control-regex
  const flattened = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flattened.length <= max ? flattened : `${flattened.slice(0, max - 1)}…`;
}

/** Reason codes are an enum-ish vocabulary, not prose; bound count and width. */
export function boundReasonCodes(raw: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const code of raw) {
    const trimmed = code.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, EXECUTION_MAP_BOUNDS.maxReasonCodeChars));
    if (out.length >= EXECUTION_MAP_BOUNDS.maxReasonCodes) break;
  }
  return Object.freeze(out);
}

/**
 * Stable, comparable identity for one occurrence, so a projector can dedupe a
 * replayed event without inventing an id of its own.
 */
export function occurrenceKey(
  nodeId: string,
  attempt: number,
  iterationPath: readonly number[],
): string {
  const path = iterationPath
    .slice(0, EXECUTION_MAP_BOUNDS.maxIterationPathDepth)
    .map((n) => String(Math.trunc(n)))
    .join('.');
  return `${nodeId}#${Math.trunc(attempt)}${path ? `@${path}` : ''}`;
}

/** Empty usage, so callers never have to spell zeros and drift apart doing it. */
export function emptyExecutionUsage(): ExecutionUsage {
  return { promptTokens: 0, completionTokens: 0, toolCalls: 0, wallClockMs: 0 };
}
