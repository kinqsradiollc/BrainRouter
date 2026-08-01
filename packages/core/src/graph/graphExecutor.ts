/**
 * ADR-027 D2 (P3-1/P3-2) — the graph executor.
 *
 * Runs a directed graph of nodes over typed state, checkpointing at NODE
 * boundaries and able to stop and resume at an interrupt.
 *
 * D2's constraints are the design, not decoration:
 *
 *   - "Checkpoint boundaries must be tool boundaries — never mid-stream, and
 *     never after dispatching a side-effecting call but before recording its
 *     result." A node is the unit; a checkpoint is taken only once a node's
 *     update has been folded in. Checkpointing between dispatch and record
 *     would resume into a world where the effect happened and the state denies
 *     it, which is the single worst outcome available.
 *   - "On resume, later nodes may re-execute, so every side-effecting node must
 *     carry an idempotency key." Enforced at definition time, because a node
 *     that forgets is indistinguishable from a safe one until a resume
 *     duplicates its effect in production.
 *
 * Scope: nothing here touches `runTurn`. Whether this replaces the turn loop in
 * 0.4.19 is the open question in ADR-027 §5.
 */

import { GraphState, type StateSchema, type StateUpdate } from './graphState.js';

/** Terminal sentinel. Routing to it ends the run. */
export const END = '__end__' as const;

export type NodeResult<S extends StateSchema> = {
  update?: StateUpdate<S>;
  /**
   * Pause here and hand control back. The state INCLUDING this node's update is
   * checkpointed first, so resuming does not re-run the work that asked to
   * pause.
   */
  interrupt?: { reason: string; payload?: unknown };
};

export interface GraphNode<S extends StateSchema> {
  id: string;
  run(state: GraphState<S>): Promise<NodeResult<S>> | NodeResult<S>;
  /**
   * True when this node changes something outside the graph. Such a node MUST
   * declare `idempotencyKey`, because resume may re-execute it.
   */
  sideEffecting?: boolean;
  /**
   * Stable key derived from the state, letting the node's effect be reconciled
   * rather than repeated. Required whenever `sideEffecting` is true.
   */
  idempotencyKey?: (state: GraphState<S>) => string;
}

/** Next node id, or END. Receives the state AFTER the source node's update. */
export type EdgeResolver<S extends StateSchema> = (state: GraphState<S>) => string;

export interface GraphDefinition<S extends StateSchema> {
  schema: S;
  entry: string;
  nodes: readonly GraphNode<S>[];
  /** Routing per node id. A node with no entry here routes to END. */
  edges?: Record<string, EdgeResolver<S>>;
  /** Safety bound on node executions, so a routing bug terminates. */
  maxSteps?: number;
}

export class GraphDefinitionError extends Error {
  constructor(message: string) { super(message); this.name = 'GraphDefinitionError'; }
}

export class GraphExecutionError extends Error {
  constructor(message: string, public readonly nodeId?: string) {
    super(message);
    this.name = 'GraphExecutionError';
  }
}

export interface GraphCheckpoint {
  /** Node to run next, or END when the run finished. */
  next: string;
  state: Record<string, unknown>;
  stepsTaken: number;
}

export type GraphRunResult<S extends StateSchema> =
  | { status: 'complete'; state: GraphState<S>; checkpoint: GraphCheckpoint; stepsTaken: number }
  | {
      status: 'interrupted';
      state: GraphState<S>;
      checkpoint: GraphCheckpoint;
      stepsTaken: number;
      interrupt: { nodeId: string; reason: string; payload?: unknown };
    };

/**
 * Validate a graph before it can run.
 *
 * Every check here is something that would otherwise fail mid-run, after side
 * effects have already landed — which is the expensive moment to discover a
 * typo in a node id.
 */
export function graphDefinitionError<S extends StateSchema>(definition: GraphDefinition<S>): string | null {
  const ids = new Set<string>();
  for (const node of definition.nodes) {
    if (ids.has(node.id)) return `Duplicate node id "${node.id}"`;
    if (node.id === END) return `"${END}" is reserved and cannot be a node id`;
    ids.add(node.id);
    if (node.sideEffecting && typeof node.idempotencyKey !== 'function') {
      // A node that forgets its key is indistinguishable from a safe one until
      // a resume duplicates its effect in production.
      return `Side-effecting node "${node.id}" must declare an idempotencyKey`;
    }
  }
  if (!ids.has(definition.entry)) return `Entry node "${definition.entry}" is not defined`;
  for (const from of Object.keys(definition.edges ?? {})) {
    if (!ids.has(from)) return `Edge declared from unknown node "${from}"`;
  }
  return null;
}

/**
 * Run a graph from its entry, or resume from a checkpoint.
 *
 * A checkpoint is emitted after EVERY node, and the returned one is always the
 * state the caller should persist — on completion, on interrupt, and on the
 * step-budget stop. There is no path that advances the graph without leaving a
 * resumable point behind.
 */
export async function runGraph<S extends StateSchema>(
  definition: GraphDefinition<S>,
  options: { from?: GraphCheckpoint; onCheckpoint?: (checkpoint: GraphCheckpoint) => void } = {},
): Promise<GraphRunResult<S>> {
  const error = graphDefinitionError(definition);
  if (error) throw new GraphDefinitionError(error);

  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  const maxSteps = definition.maxSteps ?? 100;

  let state = options.from
    ? GraphState.restore(definition.schema, options.from.state)
    : GraphState.create(definition.schema);
  let next = options.from?.next ?? definition.entry;
  let stepsTaken = options.from?.stepsTaken ?? 0;

  const checkpointAt = (nextId: string): GraphCheckpoint => {
    const checkpoint: GraphCheckpoint = { next: nextId, state: state.toCheckpoint(), stepsTaken };
    options.onCheckpoint?.(checkpoint);
    return checkpoint;
  };

  while (next !== END) {
    if (stepsTaken >= maxSteps) {
      // A routing bug must terminate rather than spin. Reported as an error
      // because silently stopping mid-graph looks identical to completing.
      throw new GraphExecutionError(`Graph exceeded ${maxSteps} steps; suspected routing cycle`, next);
    }
    const node = byId.get(next);
    if (!node) throw new GraphExecutionError(`Routed to unknown node "${next}"`, next);

    const result = await node.run(state);
    // Fold BEFORE checkpointing: a checkpoint taken between dispatching a
    // side-effecting call and recording its result would resume into a world
    // where the effect happened and the state denies it.
    if (result.update) state = state.apply(result.update);
    stepsTaken += 1;

    if (result.interrupt) {
      // Resume re-enters at the SAME node's successor, not the node itself —
      // its work is already folded in and re-running it would repeat the effect
      // the interrupt was probably asking about.
      const resumeAt = resolveNext(definition, node.id, state);
      return {
        status: 'interrupted',
        state,
        checkpoint: checkpointAt(resumeAt),
        stepsTaken,
        interrupt: { nodeId: node.id, reason: result.interrupt.reason, ...(result.interrupt.payload !== undefined ? { payload: result.interrupt.payload } : {}) },
      };
    }

    next = resolveNext(definition, node.id, state);
    checkpointAt(next);
  }

  return { status: 'complete', state, checkpoint: checkpointAt(END), stepsTaken };
}

function resolveNext<S extends StateSchema>(
  definition: GraphDefinition<S>,
  from: string,
  state: GraphState<S>,
): string {
  const resolver = definition.edges?.[from];
  // No edge means END. Explicit, because "fall through to the next node in the
  // array" would make routing depend on declaration order.
  return resolver ? resolver(state) : END;
}
