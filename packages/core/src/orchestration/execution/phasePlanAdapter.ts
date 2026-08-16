/**
 * ADR-040 A40-7 — adapt a phase-plan run to the canonical execution map.
 *
 * The saved-graph adapter (graphAdapter.ts) does this for `run_workflow_graph`;
 * this does it for the phase-plan runtime (`/build` and the other multi-agent
 * commands), which is the OTHER orchestration shape ADR-040 unifies. Both feed
 * the same reducer and the same `/runs` projection, so a phase-plan run and a
 * graph run answer the same questions in the same shape.
 *
 * It is a pure HOOK FACTORY: it hands `executePhasePlan` a set of `ExecuteHooks`
 * and, after the run resolves, exposes the canonical snapshot and event stream.
 * The phase orchestrator is not touched, and every mapping here is testable by
 * invoking the hooks directly.
 */
import { EXECUTION_MAP_SCHEMA_VERSION, type ExecutionEvent } from '@kinqs/brainrouter-agent-protocol';
import type { ExecuteHooks, PhaseExecution, PhasePlanExecution, PhaseStatus } from '../workflow/phaseOrchestrator.js';
import { ExecutionSessionStore, type ExecutionSnapshot } from './reducer.js';
import {
  startDurableRun,
  updateDurableRun,
  readDurableRunSafe,
  readDurableRunResumeState,
  type DurableRunSafeRecord,
} from './runStore.js';
import { appendRunEvent } from './runJournal.js';

/**
 * A phase's terminal state maps onto the canonical vocabulary. `partial` is
 * `degraded`, NOT `succeeded`: a phase where some children failed produced a
 * result AND lost part of what was asked, and collapsing that into success is
 * how "it worked" comes to mean "it mostly worked".
 */
export function phaseStatusToCanonical(status: PhaseStatus): string {
  switch (status) {
    case 'completed': return 'succeeded';
    case 'partial': return 'degraded';
    case 'failed': return 'failed';
    default: return 'failed';
  }
}

export interface CanonicalPhasePlanInput {
  executionId: string;
  sessionKey: string;
  startedAt: string;
  runId?: string;
  workspaceRoot?: string;
  definitionId?: string;
  definitionHash?: string;
  /** A40-9 goal-continuation — the goal this phase run was launched under, if any. */
  goalId?: string;
  /**
   * A40-7 — resume an interrupted run's durable record instead of exclusive-
   * creating a second one. On resume the emitter RE-ATTACHES to the existing
   * record (via the CAS-guarded update path, so the store's exclusive-create
   * guard for fresh launches is untouched) and CONTINUES the event sequence from
   * where the interrupted run left off, so the resumed events do not collide with
   * the pre-resume ones.
   */
  resume?: boolean;
}

export interface CanonicalPhasePlanEmitter {
  /** Pass to `executePhasePlan(plan, runner, emitter.hooks, resume)`. */
  readonly hooks: ExecuteHooks;
  /** Call once, after `executePhasePlan` resolves, with its result. */
  finish(result: PhasePlanExecution): void;
  /**
   * A40-11 — record an optimization decision (a build-loop accept/reject/rollback)
   * into the map. Best-effort like every emission here; the decision the loop
   * actually acted on stays the loop's, this only makes it visible.
   */
  emitDecision(decision: { kind: string; outcome: string; reasonCodes: readonly string[] }, nodeId?: string): void;
  snapshot(): ExecutionSnapshot | undefined;
  events(): readonly ExecutionEvent[];
  durable(): DurableRunSafeRecord | undefined;
}

interface EmissionFields {
  nodeId?: string;
  attempt?: number;
  iterationPath?: readonly number[];
  status?: string;
  childSessionIds?: readonly string[];
  /** A40-11 — an optimization decision (accept/reject/rollback) this event records. */
  decision?: { kind: string; outcome: string; reasonCodes: readonly string[] };
}

export function canonicalPhasePlanEmitter(input: CanonicalPhasePlanInput): CanonicalPhasePlanEmitter {
  const store = new ExecutionSessionStore();
  const events: ExecutionEvent[] = [];
  let sequence = 0;
  let durable: DurableRunSafeRecord | undefined;

  if (input.workspaceRoot && input.runId) {
    if (input.resume) {
      // Re-attach to the interrupted run's record and pick up its sequence, so
      // the continuation's events extend the same stream rather than colliding
      // with (or duplicating) the ones already emitted. If the record is somehow
      // gone, fall through to a fresh start.
      durable = readDurableRunSafe(input.workspaceRoot, input.runId);
      if (durable) {
        const priorSequence = (readDurableRunResumeState(input.workspaceRoot, input.runId)
          ?.resumeState as { lastSequence?: unknown } | undefined)?.lastSequence;
        if (typeof priorSequence === 'number' && priorSequence > 0) sequence = priorSequence;
      }
    }
    if (!durable) {
      durable = startDurableRun({
        workspaceRoot: input.workspaceRoot,
        runId: input.runId,
        executionId: input.executionId,
        definitionId: input.definitionId ?? null,
        goalId: input.goalId,
        definitionHash: input.definitionHash ?? null,
        startedAt: input.startedAt,
        resumeState: { lastSequence: sequence },
      });
    }
  }

  const emit = (fields: EmissionFields): void => {
    sequence += 1;
    const payload: Record<string, unknown> = {};
    if (fields.nodeId !== undefined) payload.nodeId = fields.nodeId;
    if (fields.attempt !== undefined) payload.attempt = fields.attempt;
    if (fields.iterationPath !== undefined) payload.iterationPath = [...fields.iterationPath];
    if (fields.status !== undefined) payload.status = fields.status;
    if (fields.childSessionIds !== undefined) payload.childSessionIds = [...fields.childSessionIds];
    if (fields.decision !== undefined) payload.decision = { ...fields.decision, reasonCodes: [...fields.decision.reasonCodes] };
    const event: ExecutionEvent = {
      schemaVersion: EXECUTION_MAP_SCHEMA_VERSION,
      // Identity is (execution, sequence): stable across a replay so the reducer
      // dedupes rather than double-counting.
      eventId: `${input.executionId}:${sequence}`,
      executionId: input.executionId,
      executionSequence: sequence,
      sessionKey: input.sessionKey,
      ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
      emittedAt: input.startedAt,
      nodeExecutionId: fields.nodeId,
      payload,
    };
    events.push(event);
    store.apply(event);
    // A40-9 — retain the event so `/runs` can rebuild the map from disk later.
    if (input.workspaceRoot && input.runId) appendRunEvent(input.workspaceRoot, input.runId, event);
    if (input.workspaceRoot && input.runId && durable) {
      durable = updateDurableRun(
        input.workspaceRoot,
        input.runId,
        { resumeState: { lastSequence: sequence } },
        durable.revision,
      );
    }
  };

  emit({ status: 'running' });

  const hooks: ExecuteHooks = {
    onPhaseStart: (phase) => {
      emit({ nodeId: phase.id, attempt: 1, iterationPath: [], status: 'running' });
    },
    onPhaseComplete: (execution: PhaseExecution) => {
      emit({
        nodeId: execution.id,
        attempt: 1,
        iterationPath: [],
        status: phaseStatusToCanonical(execution.status),
        // Each child is a spawned session; recording it here is what lets a
        // stage in the map be drilled into the transcript it produced (A40-5's
        // stage-child correlation, fed from the phase-plan side).
        childSessionIds: execution.children.map((child) => child.id),
      });
    },
  };

  return {
    hooks,
    emitDecision: (decision, nodeId) => {
      emit({ decision, ...(nodeId !== undefined ? { nodeId } : {}) });
    },
    finish: (result: PhasePlanExecution) => {
      emit({ status: phaseStatusToCanonical(result.status) });
      if (input.workspaceRoot && input.runId && durable) {
        durable = updateDurableRun(
          input.workspaceRoot,
          input.runId,
          {
            status: phaseStatusToCanonical(result.status),
            endedAt: input.startedAt,
            resumeState: { lastSequence: sequence },
          },
          durable.revision,
        );
      }
    },
    snapshot: () => store.snapshot(input.executionId),
    events: () => Object.freeze([...events]),
    durable: () => (input.workspaceRoot && input.runId
      ? readDurableRunSafe(input.workspaceRoot, input.runId)
      : undefined),
  };
}
