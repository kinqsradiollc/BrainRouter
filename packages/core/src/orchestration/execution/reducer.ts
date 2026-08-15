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
  boundReasonCodes,
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
  maxDecisionsPerExecution: 1_000,
  // Below maxEventsPerExecution on purpose: a sub-bound at or above the event
  // cap can never be the thing that trips, so it would not bound anything.
  maxTraversalsPerExecution: 1_000,
} as const;

/**
 * A40-7 — a typed decision the run made (an approval granted, a node degraded),
 * projected from the event stream. `kind` is recorded AS EMITTED rather than
 * policed here, so an unfamiliar decision kind is surfaced, not silently dropped.
 * `reasonCodes` are bounded; these are safe codes, never chain-of-thought.
 */
export interface ProjectedDecision {
  decisionId: string;
  kind: string;
  nodeExecutionId?: string;
  outcome: string;
  reasonCodes: readonly string[];
  decidedAt: string;
}

/**
 * A40-7 — one edge traversal, projected from the event stream. A branch NOT taken
 * (`skipped`) and one an approval closed (`blocked`) are recorded alongside the
 * edge followed (`traversed`), so the map can say why a path did not fire, not
 * only which fired. `state` is recorded as emitted rather than policed.
 */
export interface ProjectedTraversal {
  traversalId: string;
  edgeId: string;
  state: string;
  sequence: number;
}

export interface ExecutionSnapshot {
  executionId: string;
  status: ExecutionStatus;
  /** Reported separately from status: a gapped snapshot is not a failed run. */
  completeness: SnapshotCompleteness;
  /** Highest contiguous sequence applied. Everything at or below this is known. */
  watermark: number;
  occurrences: readonly ExecutionNodeOccurrence[];
  /** A40-7 — decisions the run made, in the order they were observed. */
  decisions: readonly ProjectedDecision[];
  /** A40-7 — edge traversals (taken, skipped, and approval-blocked), in order. */
  traversals: readonly ProjectedTraversal[];
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
  childSessionIds?: unknown;
};

interface ExecutionState {
  executionId: string;
  /** The session this execution belongs to; the key for session-scoped ops. */
  sessionKey: string;
  status: ExecutionStatus;
  watermark: number;
  seenEventIds: Set<string>;
  /** Buffered out-of-order events, keyed by sequence. */
  pending: Map<number, ExecutionEvent>;
  occurrences: Map<string, ExecutionNodeOccurrence>;
  decisions: ProjectedDecision[];
  traversals: ProjectedTraversal[];
  usage: ExecutionUsage;
  eventCount: number;
  truncated: boolean;
  /** A gap was observed and has not been filled. */
  gapped: boolean;
  /**
   * A40-5 — retained but hidden. Distinct from `forget`, which drops the record:
   * an archived execution still answers `snapshot()` (so a direct link keeps
   * working) but is excluded from session listings.
   */
  archived: boolean;
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

/** Union of previously-recorded child sessions with any new ones on this event. */
function mergeChildSessions(previous: readonly string[] | undefined, incoming: unknown): readonly string[] {
  const out = new Set(previous ?? []);
  if (Array.isArray(incoming)) {
    for (const id of incoming) if (typeof id === 'string' && id) out.add(id);
  }
  return Object.freeze([...out]);
}

/**
 * A bounded, per-session store of execution snapshots.
 *
 * Bounded is not a nicety: these are fed by a running agent, so "keep
 * everything" means an unbounded buffer behind a long session.
 */
export class ExecutionSessionStore {
  readonly #executions = new Map<string, ExecutionState>();
  /** A40-5 — sessionKey -> its execution ids, for session-scoped fork/archive/forget. */
  readonly #bySession = new Map<string, Set<string>>();
  /** A40-5 — child sessionKey -> the execution that spawned it, for stage-child correlation. */
  readonly #byChildSession = new Map<string, string>();

  /** Insertion-ordered eviction; the oldest execution goes first. */
  #evictIfNeeded(): void {
    while (this.#executions.size > EXECUTION_STORE_BOUNDS.maxExecutions) {
      const oldest = this.#executions.keys().next();
      if (oldest.done) return;
      this.#dropIndexes(oldest.value);
      this.#executions.delete(oldest.value);
    }
  }

  /** Remove an execution from both indexes. The record itself is left to the caller. */
  #dropIndexes(executionId: string): void {
    const state = this.#executions.get(executionId);
    if (!state) return;
    this.#bySession.get(state.sessionKey)?.delete(executionId);
    if (this.#bySession.get(state.sessionKey)?.size === 0) this.#bySession.delete(state.sessionKey);
    for (const occurrence of state.occurrences.values()) {
      for (const childId of occurrence.childSessionIds) {
        if (this.#byChildSession.get(childId) === executionId) this.#byChildSession.delete(childId);
      }
    }
  }

  #stateFor(executionId: string, sessionKey: string): ExecutionState {
    let state = this.#executions.get(executionId);
    if (!state) {
      state = {
        executionId,
        sessionKey,
        status: 'planned',
        watermark: 0,
        seenEventIds: new Set(),
        pending: new Map(),
        occurrences: new Map(),
        decisions: [],
        traversals: [],
        usage: emptyExecutionUsage(),
        eventCount: 0,
        truncated: false,
        gapped: false,
        archived: false,
      };
      this.#executions.set(executionId, state);
      let ids = this.#bySession.get(sessionKey);
      if (!ids) { ids = new Set(); this.#bySession.set(sessionKey, ids); }
      ids.add(executionId);
      this.#evictIfNeeded();
    }
    return state;
  }

  /**
   * Apply one event. Returns false when the event was ignored — a duplicate, a
   * sequence at or below the watermark, or a transition a terminal run refuses.
   */
  apply(event: ExecutionEvent): boolean {
    const state = this.#stateFor(event.executionId, event.sessionKey);

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

    // A40-7 — project any decision this event carries (an approval granted, a
    // node degraded). Independent of the status/occurrence branches below: one
    // event can advance a node AND record the decision made at it, so this runs
    // first and unconditionally. Deduplication already happened in `apply`, so a
    // replayed event does not double-record its decision.
    const rawDecision = (event.payload as { decision?: unknown } | undefined)?.decision;
    if (rawDecision && typeof rawDecision === 'object') {
      if (state.decisions.length >= EXECUTION_STORE_BOUNDS.maxDecisionsPerExecution) {
        state.truncated = true;
      } else {
        const d = rawDecision as { kind?: unknown; outcome?: unknown; reasonCodes?: unknown };
        state.decisions.push({
          decisionId: event.eventId,
          kind: typeof d.kind === 'string' ? d.kind : 'unknown',
          nodeExecutionId: event.nodeExecutionId
            ?? (typeof payload.nodeId === 'string' ? payload.nodeId : undefined),
          outcome: typeof d.outcome === 'string' ? d.outcome : '',
          reasonCodes: boundReasonCodes(
            Array.isArray(d.reasonCodes)
              ? d.reasonCodes.filter((c): c is string => typeof c === 'string')
              : [],
          ),
          decidedAt: event.emittedAt,
        });
      }
    }

    // A40-7 — project any edge traversal this event carries. Also independent of
    // the status/occurrence branches: an edge event carries only edgeId+edgeState.
    const rawEdgeId = (event.payload as { edgeId?: unknown } | undefined)?.edgeId;
    if (typeof rawEdgeId === 'string') {
      if (state.traversals.length >= EXECUTION_STORE_BOUNDS.maxTraversalsPerExecution) {
        state.truncated = true;
      } else {
        const rawEdgeState = (event.payload as { edgeState?: unknown } | undefined)?.edgeState;
        state.traversals.push({
          traversalId: event.eventId,
          edgeId: rawEdgeId,
          state: typeof rawEdgeState === 'string' ? rawEdgeState : 'traversed',
          sequence: event.executionSequence,
        });
      }
    }

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
      // A40-5 — stage-child correlation. New child session ids on this occurrence
      // are unioned with any already recorded, and each is indexed back to this
      // execution so a child transcript can be traced to the stage that spawned it.
      const childSessionIds = mergeChildSessions(previous?.childSessionIds, payload.childSessionIds);
      for (const childId of childSessionIds) this.#byChildSession.set(childId, state.executionId);
      state.occurrences.set(key, {
        nodeExecutionId: event.nodeExecutionId ?? key,
        nodeId: payload.nodeId,
        attempt,
        iterationPath,
        status,
        childSessionIds,
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
      decisions: Object.freeze([...state.decisions]),
      traversals: Object.freeze([...state.traversals]),
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
    this.#dropIndexes(executionId);
    this.#executions.delete(executionId);
  }

  // ── A40-5 — session lifecycle ────────────────────────────────────────────

  /**
   * The execution ids for a session, newest-insertion last. Archived executions
   * are excluded unless asked for — that is the whole point of archive vs forget.
   */
  executionsForSession(sessionKey: string, opts: { includeArchived?: boolean } = {}): readonly string[] {
    const ids = this.#bySession.get(sessionKey);
    if (!ids) return Object.freeze([]);
    const out: string[] = [];
    for (const id of ids) {
      const state = this.#executions.get(id);
      if (!state) continue;
      if (state.archived && !opts.includeArchived) continue;
      out.push(id);
    }
    return Object.freeze(out);
  }

  /**
   * Drop every execution for a session — the transcript delete, and the hook a
   * host calls on workspace switch to stop projecting the session it left.
   * Returns the ids removed.
   */
  forgetSession(sessionKey: string): readonly string[] {
    const ids = [...(this.#bySession.get(sessionKey) ?? [])];
    for (const id of ids) {
      this.#dropIndexes(id);
      this.#executions.delete(id);
    }
    return Object.freeze(ids);
  }

  /**
   * Hide a session's executions from listings while keeping them readable by id.
   * Retained, not dropped: a direct `snapshot(id)` still answers.
   */
  archiveSession(sessionKey: string): readonly string[] {
    const ids = [...(this.#bySession.get(sessionKey) ?? [])];
    for (const id of ids) {
      const state = this.#executions.get(id);
      if (state) state.archived = true;
    }
    return Object.freeze(ids);
  }

  isArchived(executionId: string): boolean {
    return this.#executions.get(executionId)?.archived ?? false;
  }

  /**
   * Fork: the forked session inherits the source session's execution HISTORY by
   * reference. The executions are immutable projections of past events, so the
   * fork shares them rather than copying — and new events under the forked
   * session key create their own executions, leaving the shared history intact.
   * A fork of a session that does not exist inherits nothing.
   */
  forkSession(sourceSessionKey: string, forkedSessionKey: string): readonly string[] {
    const source = this.#bySession.get(sourceSessionKey);
    if (!source || source.size === 0) return Object.freeze([]);
    let forked = this.#bySession.get(forkedSessionKey);
    if (!forked) { forked = new Set(); this.#bySession.set(forkedSessionKey, forked); }
    for (const id of source) forked.add(id);
    return Object.freeze([...source]);
  }

  /** The execution that spawned a child session, for stage-child drill-down. */
  executionForChildSession(childSessionId: string): string | undefined {
    return this.#byChildSession.get(childSessionId);
  }
}

/** Convenience fold for callers that already hold the whole event list. */
export function reduceExecutionEvents(events: readonly ExecutionEvent[]): ExecutionSessionStore {
  const store = new ExecutionSessionStore();
  for (const event of events) store.apply(event);
  return store;
}

