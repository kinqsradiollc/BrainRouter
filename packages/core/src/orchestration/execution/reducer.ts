/**
 * ADR-040 A40-5 — the Core reducer over execution events.
 *
 * The protocol package owns the vocabulary; this owns every transition. It is a
 * pure fold: events in, snapshot out, no I/O and no clock of its own.
 *
 * Three properties are the whole point, and each of them is invisible when it is
 * missing — the snapshot still renders, it is just quietly wrong:
 *
 *   1. IDEMPOTENT. A host that reconnects replays. If a replayed event is
 *      applied twice, usage doubles and attempt counts drift, and the map is
 *      confidently wrong rather than obviously broken.
 *   2. GAP-AWARE. `executionSequence` is contiguous per execution. A hole means
 *      the snapshot is INCOMPLETE, and it must say so rather than render the
 *      events it happens to hold as if they were all of them.
 *   3. TERMINAL-SAFE. A late event cannot resurrect a finished run.
 */
import {
  canTransitionExecutionStatus,
  emptyExecutionUsage,
  isExecutionStatus,
  isNodeOccurrenceStatus,
  occurrenceKey,
  type ExecutionEvent,
  type ExecutionNodeOccurrence,
  type ExecutionStatus,
  type ExecutionUsage,
  type NodeOccurrenceStatus,
  type SnapshotCompleteness,
} from '@kinqs/brainrouter-agent-protocol';

/** Bounds so one runaway execution cannot grow the store without limit. */
export const EXECUTION_STORE_BOUNDS = {
  maxExecutions: 200,
  maxEventsPerExecution: 2_000,
  maxOccurrencesPerExecution: 1_000,
} as const;

export interface ExecutionSnapshot {
  executionId: string;
  status: ExecutionStatus;
  /** Reported separately from status: a gapped snapshot is not a failed run. */
  completeness: SnapshotCompleteness;
  /** Highest contiguous sequence applied. Everything at or below this is known. */
  watermark: number;
  occurrences: readonly ExecutionNodeOccurrence[];
  usage: ExecutionUsage;
  /** Sequences observed but NOT applied because something before them is missing. */
  pendingSequences: readonly number[];
  /** True once the store dropped events for this execution to stay bounded. */
  truncated: boolean;
}

type StatusPayload = { status?: unknown };
type OccurrencePayload = {
  nodeId?: unknown;
  attempt?: unknown;
  iterationPath?: unknown;
  status?: unknown;
  usage?: unknown;
};

interface ExecutionState {
  executionId: string;
  status: ExecutionStatus;
  watermark: number;
  seenEventIds: Set<string>;
  /** Buffered out-of-order events, keyed by sequence. */
  pending: Map<number, ExecutionEvent>;
  occurrences: Map<string, ExecutionNodeOccurrence>;
  usage: ExecutionUsage;
  eventCount: number;
  truncated: boolean;
  /** A gap was observed and has not been filled. */
  gapped: boolean;
}

function addUsage(into: ExecutionUsage, add: Partial<ExecutionUsage> | undefined): ExecutionUsage {
  if (!add) return into;
  return {
    promptTokens: into.promptTokens + (Number(add.promptTokens) || 0),
    completionTokens: into.completionTokens + (Number(add.completionTokens) || 0),
    toolCalls: into.toolCalls + (Number(add.toolCalls) || 0),
    wallClockMs: into.wallClockMs + (Number(add.wallClockMs) || 0),
  };
}

function numericPath(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((n) => Math.trunc(Number(n))).filter((n) => Number.isFinite(n));
}

/**
 * A bounded, per-session store of execution snapshots.
 *
 * Bounded is not a nicety: these are fed by a running agent, so "keep
 * everything" means an unbounded buffer behind a long session.
 */
export class ExecutionSessionStore {
  readonly #executions = new Map<string, ExecutionState>();

  /** Insertion-ordered eviction; the oldest execution goes first. */
  #evictIfNeeded(): void {
    while (this.#executions.size > EXECUTION_STORE_BOUNDS.maxExecutions) {
      const oldest = this.#executions.keys().next();
      if (oldest.done) return;
      this.#executions.delete(oldest.value);
    }
  }

  #stateFor(executionId: string): ExecutionState {
    let state = this.#executions.get(executionId);
    if (!state) {
      state = {
        executionId,
        status: 'planned',
        watermark: 0,
        seenEventIds: new Set(),
        pending: new Map(),
        occurrences: new Map(),
        usage: emptyExecutionUsage(),
        eventCount: 0,
        truncated: false,
        gapped: false,
      };
      this.#executions.set(executionId, state);
      this.#evictIfNeeded();
    }
    return state;
  }

  /**
   * Apply one event. Returns false when the event was ignored — a duplicate, a
   * sequence at or below the watermark, or a transition a terminal run refuses.
   */
  apply(event: ExecutionEvent): boolean {
    const state = this.#stateFor(event.executionId);

    // Idempotency first: a replayed event is not new information.
    if (state.seenEventIds.has(event.eventId)) return false;

    if (state.eventCount >= EXECUTION_STORE_BOUNDS.maxEventsPerExecution) {
      state.truncated = true;
      return false;
    }

    // Anything at or below the watermark is already folded in.
    if (event.executionSequence <= state.watermark) return false;

    state.seenEventIds.add(event.eventId);
    state.eventCount += 1;

    if (event.executionSequence === state.watermark + 1) {
      this.#fold(state, event);
      state.watermark = event.executionSequence;
      this.#drainPending(state);
    } else {
      // Out of order: hold it, and remember that we are missing something.
      state.pending.set(event.executionSequence, event);
      state.gapped = true;
    }
    return true;
  }

  #drainPending(state: ExecutionState): void {
    for (;;) {
      const next = state.pending.get(state.watermark + 1);
      if (!next) break;
      state.pending.delete(state.watermark + 1);
      this.#fold(state, next);
      state.watermark += 1;
    }
    if (state.pending.size === 0) state.gapped = false;
  }

  #fold(state: ExecutionState, event: ExecutionEvent): void {
    const payload = (event.payload ?? {}) as StatusPayload & OccurrencePayload;

    if (typeof payload.status === 'string' && !('nodeId' in payload)) {
      const next = payload.status;
      // Terminal is final; a late event must not resurrect a finished run.
      if (isExecutionStatus(next) && canTransitionExecutionStatus(state.status, next)) {
        state.status = next;
      }
      return;
    }

    if (typeof payload.nodeId === 'string') {
      if (state.occurrences.size >= EXECUTION_STORE_BOUNDS.maxOccurrencesPerExecution) {
        state.truncated = true;
        return;
      }
      const attempt = Math.trunc(Number(payload.attempt ?? 1)) || 1;
      const iterationPath = numericPath(payload.iterationPath);
      const key = occurrenceKey(payload.nodeId, attempt, iterationPath);
      const status: NodeOccurrenceStatus =
        typeof payload.status === 'string' && isNodeOccurrenceStatus(payload.status)
          ? payload.status
          : 'running';
      const previous = state.occurrences.get(key);
      const usage = addUsage(
        previous?.usage ?? emptyExecutionUsage(),
        payload.usage as Partial<ExecutionUsage> | undefined,
      );
      state.occurrences.set(key, {
        nodeExecutionId: event.nodeExecutionId ?? key,
        nodeId: payload.nodeId,
        attempt,
        iterationPath,
        status,
        childSessionIds: previous?.childSessionIds ?? [],
        usage,
        terminalReasonCodes: previous?.terminalReasonCodes ?? [],
      });
      state.usage = addUsage(state.usage, payload.usage as Partial<ExecutionUsage> | undefined);
    }
  }

  snapshot(executionId: string): ExecutionSnapshot | undefined {
    const state = this.#executions.get(executionId);
    if (!state) return undefined;
    return {
      executionId,
      status: state.status,
      // Truncation is a form of not-knowing too, so it reports as gapped rather
      // than letting a bounded store quietly present itself as the whole story.
      completeness: state.gapped || state.truncated ? 'gapped' : 'complete',
      watermark: state.watermark,
      occurrences: Object.freeze([...state.occurrences.values()]),
      usage: state.usage,
      pendingSequences: Object.freeze([...state.pending.keys()].sort((a, b) => a - b)),
      truncated: state.truncated,
    };
  }

  /** An execution this store has never seen is `unavailable`, not `complete`. */
  completenessFor(executionId: string): SnapshotCompleteness {
    return this.snapshot(executionId)?.completeness ?? 'unavailable';
  }

  get size(): number {
    return this.#executions.size;
  }

  forget(executionId: string): void {
    this.#executions.delete(executionId);
  }
}

/** Convenience fold for callers that already hold the whole event list. */
export function reduceExecutionEvents(events: readonly ExecutionEvent[]): ExecutionSessionStore {
  const store = new ExecutionSessionStore();
  for (const event of events) store.apply(event);
  return store;
}

