/**
 * ADR-040 A40-7 — adapt a saved graph run to the canonical execution map.
 *
 * This is the seam the previous three slices were built for: the graph engine
 * emits what it knows, this maps it into A40-4's vocabulary, A40-5's reducer
 * projects it, and A40-6's store persists enough to resume. Until this existed
 * those three were orphans, which the E1 sweep said out loud rather than
 * letting them sit as scenery.
 *
 * The durable write happens on EVERY canonical event, not only at the end. A
 * run that persists its state once at completion has no resume point precisely
 * when it needs one — the process died before it got there.
 */
import { EXECUTION_MAP_SCHEMA_VERSION, type ExecutionEvent } from '@kinqs/brainrouter-agent-protocol';
import type { WorkflowGraph } from '../../workflow/graph/graph.js';
import {
  runGraph,
  type GraphExecutionEmission,
  type GraphRunDeps,
  type GraphRunResult,
} from '../../workflow/graph/graphEngine.js';
import { ExecutionSessionStore, type ExecutionSnapshot } from './reducer.js';
import {
  startDurableRun,
  updateDurableRun,
  readDurableRunSafe,
  type DurableRunSafeRecord,
} from './runStore.js';

export interface CanonicalGraphRunInput {
  graph: WorkflowGraph;
  deps: Omit<GraphRunDeps, 'emitExecution' | 'executionId'>;
  executionId: string;
  runId: string;
  sessionKey: string;
  /** Absent = project in memory only; present = also persist for resume. */
  workspaceRoot?: string;
  startedAt: string;
  definitionId?: string;
  definitionHash?: string;
}

export interface CanonicalGraphRunResult {
  result: GraphRunResult;
  snapshot: ExecutionSnapshot;
  durable?: DurableRunSafeRecord;
}

/** Map one engine emission into a canonical event. Pure. */
export function toExecutionEvent(
  emission: GraphExecutionEmission,
  sessionKey: string,
  emittedAt: string,
): ExecutionEvent {
  const payload: Record<string, unknown> = {};
  if (emission.nodeId !== undefined) payload.nodeId = emission.nodeId;
  if (emission.attempt !== undefined) payload.attempt = emission.attempt;
  if (emission.iterationPath !== undefined) payload.iterationPath = [...emission.iterationPath];
  if (emission.status !== undefined) payload.status = emission.status;
  if (emission.edgeId !== undefined) payload.edgeId = emission.edgeId;
  if (emission.edgeState !== undefined) payload.edgeState = emission.edgeState;
  if (emission.decision !== undefined) payload.decision = emission.decision;
  if (emission.reasonCodes !== undefined) payload.reasonCodes = [...emission.reasonCodes];
  return {
    schemaVersion: EXECUTION_MAP_SCHEMA_VERSION,
    // Identity is (execution, sequence): stable across a replay, which is what
    // lets the reducer drop a duplicate instead of double-counting it.
    eventId: `${emission.executionId}:${emission.executionSequence}`,
    executionId: emission.executionId,
    executionSequence: emission.executionSequence,
    sessionKey,
    emittedAt,
    nodeExecutionId: emission.nodeId,
    payload,
  };
}

/**
 * Run a saved graph and produce its canonical execution map, persisting resume
 * state as it goes when a workspace is supplied.
 */
export async function runGraphAsCanonicalExecution(
  input: CanonicalGraphRunInput,
): Promise<CanonicalGraphRunResult> {
  const store = new ExecutionSessionStore();
  const events: ExecutionEvent[] = [];

  let durable: DurableRunSafeRecord | undefined;
  if (input.workspaceRoot) {
    durable = startDurableRun({
      workspaceRoot: input.workspaceRoot,
      runId: input.runId,
      executionId: input.executionId,
      definitionId: input.definitionId ?? null,
      definitionHash: input.definitionHash ?? null,
      startedAt: input.startedAt,
      resumeState: { lastSequence: 0 },
    });
  }

  const emit = (emission: GraphExecutionEmission): void => {
    const event = toExecutionEvent(emission, input.sessionKey, input.startedAt);
    events.push(event);
    store.apply(event);
    if (!input.workspaceRoot || !durable) return;
    // Persist as we go. A run that saves only at the end has no resume point at
    // the exact moment it needs one.
    durable = updateDurableRun(
      input.workspaceRoot,
      input.runId,
      { resumeState: { lastSequence: event.executionSequence } },
      durable.revision,
    );
  };

  const result = await runGraph(input.graph, {
    ...input.deps,
    executionId: input.executionId,
    emitExecution: emit,
  });

  if (input.workspaceRoot && durable) {
    // Carry the resume state through the FINAL write too. Advancing only the
    // safe half here would leave the pair torn at completion, and the store's
    // torn-pair guard would then correctly refuse to read a resume point for a
    // run that ended perfectly normally. The invariant is that the two halves
    // move together; the guard exists for crashes, not for our own last write.
    const lastSequence = events[events.length - 1]?.executionSequence ?? 0;
    durable = updateDurableRun(
      input.workspaceRoot,
      input.runId,
      {
        status: result.ok ? 'succeeded' : 'failed',
        endedAt: input.startedAt,
        resumeState: { lastSequence },
      },
      durable.revision,
    );
  }

  return {
    result,
    snapshot: store.snapshot(input.executionId)!,
    durable: input.workspaceRoot ? readDurableRunSafe(input.workspaceRoot, input.runId) : undefined,
  };
}

/** Re-project a recorded event stream. Used by resume and by replay. */
export function projectExecutionEvents(
  executionId: string,
  events: readonly ExecutionEvent[],
): ExecutionSnapshot | undefined {
  const store = new ExecutionSessionStore();
  for (const event of events) store.apply(event);
  return store.snapshot(executionId);
}
