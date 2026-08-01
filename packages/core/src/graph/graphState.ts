/**
 * ADR-027 D2 (P3-1) — typed graph state, the part a turn loop cannot express.
 *
 * A loop accumulates state by mutation: each phase reaches into a shared object
 * and writes what it likes. That works until two phases write the same field,
 * or a resumed run needs to know which writes already happened, and then it
 * fails in a way that is nearly impossible to reason about after the fact.
 *
 * The difference that matters is not "nodes and edges" — it is that every piece
 * of state declares HOW UPDATES MERGE. A node returns an update; the channel's
 * reducer decides what that means. Messages append. A status replaces. A set of
 * visited files unions. Once merge semantics are declared per channel rather
 * than improvised per writer, parallel fan-in stops being a data race and
 * resume stops being guesswork.
 *
 * Scope note: this is the state model ONLY. Whether a graph engine replaces the
 * turn loop in 0.4.19 is an open question in ADR-027 §5, and nothing here
 * touches the existing loop. Landing the rule and deferring the wiring is the
 * same approach taken for the attachment policy, whose storage migration was
 * deliberately left out.
 */

/**
 * How a channel folds an update into its current value.
 *
 * Receives `undefined` when the channel has no value yet, so a reducer defines
 * its own empty case rather than the framework guessing one.
 */
export type ChannelReducer<T> = (current: T | undefined, update: T) => T;

export interface ChannelSpec<T> {
  reducer: ChannelReducer<T>;
  /** Value before any node writes. Omit for "absent until written". */
  initial?: T;
}

export type StateSchema = Record<string, ChannelSpec<any>>;

export type StateOf<S extends StateSchema> = {
  [K in keyof S]: S[K] extends ChannelSpec<infer T> ? T | undefined : never;
};

/** Partial write from one node. Channels it omits are left untouched. */
export type StateUpdate<S extends StateSchema> = {
  [K in keyof S]?: S[K] extends ChannelSpec<infer T> ? T : never;
};

/** Last write wins. The right default for scalars — a status, a chosen model. */
export function lastValue<T>(): ChannelReducer<T> {
  return (_current, update) => update;
}

/** Append. For message logs and event streams, where order is the content. */
export function appendAll<T>(): ChannelReducer<T[]> {
  return (current, update) => [...(current ?? []), ...update];
}

/**
 * Set union, order-preserving on first sight.
 *
 * Deliberately not `[...new Set([...a, ...b])]` inline at each call site: fan-in
 * from parallel branches must be ORDER-INDEPENDENT in content, and centralising
 * it is what makes that checkable.
 */
export function unionOf<T>(): ChannelReducer<T[]> {
  return (current, update) => {
    const seen = new Set(current ?? []);
    const out = [...(current ?? [])];
    for (const item of update) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
    return out;
  };
}

/** Numeric accumulation — token counts, retry tallies. */
export function sum(): ChannelReducer<number> {
  return (current, update) => (current ?? 0) + update;
}

/**
 * Reject concurrent writes.
 *
 * For a channel only one branch may legitimately own. Two writers is a graph
 * bug, and surfacing it beats silently keeping one of them — which is what any
 * merge strategy would do.
 */
export function exclusive<T>(name: string): ChannelReducer<T> {
  return (current, update) => {
    if (current !== undefined && current !== update) {
      throw new GraphStateError(`Channel "${name}" was written twice with different values`);
    }
    return update;
  };
}

/**
 * Detach a value from every reference it shares with its source.
 *
 * Checkpoint payloads are serializable by construction (they are written to and
 * read from durable storage), so a structured clone is both sufficient and the
 * cheapest honest option. A value that cannot be cloned cannot be checkpointed
 * either, so failing here rather than at write time surfaces it sooner.
 */
function isolate<T>(value: T): T {
  return structuredClone(value);
}

export class GraphStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphStateError';
  }
}

/**
 * An immutable typed state value.
 *
 * Every application returns a NEW instance. That is what makes a checkpoint a
 * value rather than a snapshot of something still being mutated underneath it —
 * and D2's checkpoint rule is unimplementable without it.
 */
export class GraphState<S extends StateSchema> {
  private constructor(
    private readonly schema: S,
    private readonly values: Record<string, unknown>,
  ) {}

  static create<S extends StateSchema>(schema: S): GraphState<S> {
    const values: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(schema)) {
      // Clone the initial: a schema is a shared, long-lived object, and handing
      // its array straight to a state would let one run mutate the default for
      // every subsequent one.
      if (spec.initial !== undefined) values[key] = isolate(spec.initial);
    }
    return new GraphState(schema, values);
  }

  /** Restore from a checkpoint. Unknown channels are rejected, not ignored. */
  static restore<S extends StateSchema>(schema: S, values: Record<string, unknown>): GraphState<S> {
    const unknown = Object.keys(values).filter((key) => !(key in schema));
    if (unknown.length > 0) {
      // A checkpoint written by a different graph version is not resumable
      // here; silently dropping channels would resume into a state the graph
      // never actually reached.
      throw new GraphStateError(`Checkpoint has unknown channel(s): ${unknown.sort().join(', ')}`);
    }
    return new GraphState(schema, isolate(values));
  }

  get<K extends keyof S & string>(channel: K): StateOf<S>[K] {
    return this.values[channel] as StateOf<S>[K];
  }

  /** Fold an update through each channel's reducer, returning a new state. */
  apply(update: StateUpdate<S>): GraphState<S> {
    const next = { ...this.values };
    for (const [channel, value] of Object.entries(update)) {
      if (value === undefined) continue;
      const spec = this.schema[channel];
      if (!spec) throw new GraphStateError(`Unknown channel "${channel}"`);
      next[channel] = spec.reducer(next[channel], value);
    }
    return new GraphState(this.schema, next);
  }

  /**
   * Fold several updates — the fan-in case.
   *
   * Applied in the order given. Reducers whose result depends on that order
   * (`lastValue`) will differ; reducers that fan-in is supposed to use
   * (`appendAll`, `unionOf`, `sum`) will not. That difference is the point:
   * choosing `lastValue` for a channel two parallel branches write is the bug,
   * and it should be visible in the schema rather than hidden in a merge.
   */
  applyAll(updates: readonly StateUpdate<S>[]): GraphState<S> {
    return updates.reduce<GraphState<S>>((state, update) => state.apply(update), this);
  }

  /**
   * Serializable snapshot for a checkpoint.
   *
   * DEEP copy, not a spread. A shallow copy shares every array and object with
   * the live state, so whoever holds the checkpoint can mutate the state
   * through it — and a checkpoint you can mutate the original through is not a
   * value, which is exactly what D2's checkpoint rule requires it to be.
   */
  toCheckpoint(): Record<string, unknown> {
    return isolate(this.values);
  }
}
